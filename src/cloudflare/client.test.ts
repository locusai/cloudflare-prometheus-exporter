import { describe, expect, it } from "vitest";
import { ErrorCode } from "../lib/errors";
import { CloudflareMetricsClient } from "./client";

function createClient(
	fetch: typeof globalThis.fetch,
	queryLimit = 100,
): CloudflareMetricsClient {
	return new CloudflareMetricsClient({
		apiToken: "test-token",
		queryLimit,
		scrapeDelaySeconds: 300,
		timeWindowSeconds: 60,
		fetch,
	});
}

describe("CloudflareMetricsClient", () => {
	it.each([
		"worker-totals",
		"logpush-account",
		"magic-transit",
		"magic-transit-slo",
		"magic-transit-traffic",
		"magic-firewall-samples",
		"network-analytics",
		"stream-video-playback",
		"stream-live-inputs",
		"workers-kv-operations",
	] as const)(
		"surfaces %s access denial instead of reporting an empty refresh",
		async (query) => {
			const fetch: typeof globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						errors: [
							{
								message: "account does not have access to the path",
								extensions: { code: "FORBIDDEN" },
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			const client = createClient(fetch);

			await expect(
				client.getAccountMetrics(query, "account-id", "Account", {
					mintime: "2026-01-01T00:00:00.000Z",
					maxtime: "2026-01-01T00:01:00.000Z",
				}),
			).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_FIELD_ACCESS });
		},
	);

	it("allows a successful query with no observations", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), {
				headers: { "content-type": "application/json" },
			});
		const client = createClient(fetch);

		await expect(
			client.getAccountMetrics("network-analytics", "account-id", "Account", {
				mintime: "2026-01-01T00:00:00.000Z",
				maxtime: "2026-01-01T00:01:00.000Z",
			}),
		).resolves.toEqual([]);
	});

	it.each([
		"http-metrics",
		"adaptive-metrics",
		"edge-country-metrics",
		"colo-metrics",
		"colo-error-metrics",
		"request-method-metrics",
		"health-check-metrics",
		"load-balancer-metrics",
		"logpush-zone",
		"origin-status-metrics",
		"cache-miss-metrics",
		"hostname-http-metrics",
	] as const)(
		"surfaces %s access denial for exporter backoff",
		async (query) => {
			const fetch: typeof globalThis.fetch = async () =>
				new Response(
					JSON.stringify({
						errors: [
							{
								message: "zone does not have access to the path",
								extensions: { code: "FORBIDDEN" },
							},
						],
					}),
					{ headers: { "content-type": "application/json" } },
				);
			const client = createClient(fetch);

			await expect(
				client.getZoneMetrics(
					query,
					["zone-id"],
					[
						{
							id: "zone-id",
							name: "example.com",
							status: "active",
							plan: { id: "paid", name: "Paid" },
							account: { id: "account-id", name: "Account" },
						},
					],
					{},
					{
						mintime: "2026-01-01T00:00:00.000Z",
						maxtime: "2026-01-01T00:01:00.000Z",
					},
					query === "hostname-http-metrics"
						? new Set(["example.com"])
						: undefined,
				),
			).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_FIELD_ACCESS });
		},
	);
});

const KV_TIME_RANGE = {
	mintime: "2026-01-01T00:00:00.000Z",
	maxtime: "2026-01-01T00:01:00.000Z",
};

type KvGroup = {
	dimensions: { namespaceId: string; actionType: string } | null;
	sum: { requests: number | null } | null;
};

function kvGroup(
	namespaceId: string,
	actionType: string,
	requests: number,
): KvGroup {
	return { dimensions: { namespaceId, actionType }, sum: { requests } };
}

function kvFetch(groups: KvGroup[]): typeof globalThis.fetch {
	return async () =>
		new Response(
			JSON.stringify({
				data: {
					viewer: { accounts: [{ kvOperationsAdaptiveGroups: groups }] },
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
}

function findMetric(
	metrics: Awaited<ReturnType<CloudflareMetricsClient["getAccountMetrics"]>>,
	name: string,
) {
	return metrics.find((metric) => metric.name === name);
}

const KV_OPERATIONS = "cloudflare_worker_kv_operations_total";
const KV_LAST_SUCCESS = "cloudflare_worker_kv_last_success_timestamp_seconds";

describe("workers-kv-operations", () => {
	it("maps every action type across multiple namespaces", async () => {
		const client = createClient(
			kvFetch([
				kvGroup("ns-a", "read", 1200),
				kvGroup("ns-a", "write", 30),
				kvGroup("ns-b", "delete", 4),
				kvGroup("ns-b", "list", 7),
			]),
		);

		const metrics = await client.getAccountMetrics(
			"workers-kv-operations",
			"account-id",
			"Account",
			KV_TIME_RANGE,
		);

		const operations = findMetric(metrics, KV_OPERATIONS);
		expect(operations?.type).toBe("counter");
		expect(operations?.values).toEqual([
			{
				labels: {
					account: "account",
					namespace_id: "ns-a",
					action_type: "read",
				},
				value: 1200,
			},
			{
				labels: {
					account: "account",
					namespace_id: "ns-a",
					action_type: "write",
				},
				value: 30,
			},
			{
				labels: {
					account: "account",
					namespace_id: "ns-b",
					action_type: "delete",
				},
				value: 4,
			},
			{
				labels: {
					account: "account",
					namespace_id: "ns-b",
					action_type: "list",
				},
				value: 7,
			},
		]);
	});

	it("queries the exact half-open time window", async () => {
		let body: string | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			body = init?.body as string;
			return new Response(
				JSON.stringify({
					data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: [] }] } },
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		const client = createClient(fetch, 5000);

		await client.getAccountMetrics(
			"workers-kv-operations",
			"account-id",
			"Account",
			KV_TIME_RANGE,
		);

		const request = JSON.parse(body ?? "{}");
		expect(request.variables).toEqual({
			accountID: "account-id",
			mintime: KV_TIME_RANGE.mintime,
			maxtime: KV_TIME_RANGE.maxtime,
			limit: 5000,
		});
		expect(request.query).toContain("datetime_geq: $mintime");
		expect(request.query).toContain("datetime_lt: $maxtime");
	});

	it("normalizes account names into labels per account", async () => {
		const client = createClient(kvFetch([kvGroup("ns-a", "read", 5)]));

		const first = await client.getAccountMetrics(
			"workers-kv-operations",
			"account-one",
			"Locus Production",
			KV_TIME_RANGE,
		);
		const second = await client.getAccountMetrics(
			"workers-kv-operations",
			"account-two",
			"Locus QA",
			KV_TIME_RANGE,
		);

		expect(findMetric(first, KV_OPERATIONS)?.values[0]?.labels.account).toBe(
			"locus-production",
		);
		expect(findMetric(second, KV_OPERATIONS)?.values[0]?.labels.account).toBe(
			"locus-qa",
		);
		expect(findMetric(second, KV_LAST_SUCCESS)?.values[0]?.labels).toEqual({
			account: "locus-qa",
		});
	});

	it("updates the last-success gauge on a successful empty response", async () => {
		const client = createClient(kvFetch([]));
		const before = Math.floor(Date.now() / 1000);

		const metrics = await client.getAccountMetrics(
			"workers-kv-operations",
			"account-id",
			"Account",
			KV_TIME_RANGE,
		);

		const operations = findMetric(metrics, KV_OPERATIONS);
		expect(operations?.values).toEqual([]);

		const lastSuccess = findMetric(metrics, KV_LAST_SUCCESS);
		expect(lastSuccess?.type).toBe("gauge");
		expect(lastSuccess?.values[0]?.value).toBeGreaterThanOrEqual(before);
	});

	it("skips groups with a null request sum instead of reporting zero", async () => {
		const client = createClient(
			kvFetch([
				{ dimensions: { namespaceId: "ns-a", actionType: "read" }, sum: null },
				{
					dimensions: { namespaceId: "ns-b", actionType: "read" },
					sum: { requests: null },
				},
				kvGroup("ns-c", "read", 9),
			]),
		);

		const metrics = await client.getAccountMetrics(
			"workers-kv-operations",
			"account-id",
			"Account",
			KV_TIME_RANGE,
		);

		expect(findMetric(metrics, KV_OPERATIONS)?.values).toEqual([
			{
				labels: {
					account: "account",
					namespace_id: "ns-c",
					action_type: "read",
				},
				value: 9,
			},
		]);
	});

	it("labels missing dimensions as unknown", async () => {
		const client = createClient(
			kvFetch([{ dimensions: null, sum: { requests: 3 } }]),
		);

		const metrics = await client.getAccountMetrics(
			"workers-kv-operations",
			"account-id",
			"Account",
			KV_TIME_RANGE,
		);

		expect(findMetric(metrics, KV_OPERATIONS)?.values[0]?.labels).toEqual({
			account: "account",
			namespace_id: "unknown",
			action_type: "unknown",
		});
	});

	it("labels unsupported action types as unknown", async () => {
		const client = createClient(kvFetch([kvGroup("ns-a", "purge", 3)]));

		const metrics = await client.getAccountMetrics(
			"workers-kv-operations",
			"account-id",
			"Account",
			KV_TIME_RANGE,
		);

		expect(findMetric(metrics, KV_OPERATIONS)?.values[0]?.labels).toEqual({
			account: "account",
			namespace_id: "ns-a",
			action_type: "unknown",
		});
	});

	it("rejects a result that reaches the query limit", async () => {
		const client = createClient(
			kvFetch([kvGroup("ns-a", "read", 1), kvGroup("ns-b", "read", 2)]),
			2,
		);

		await expect(
			client.getAccountMetrics(
				"workers-kv-operations",
				"account-id",
				"Account",
				KV_TIME_RANGE,
			),
		).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR, retryable: true });
	});

	it("throws when the account result is missing", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), {
				headers: { "content-type": "application/json" },
			});
		const client = createClient(fetch);

		await expect(
			client.getAccountMetrics(
				"workers-kv-operations",
				"account-id",
				"Account",
				KV_TIME_RANGE,
			),
		).rejects.toThrow("expected 1");
	});

	it("throws on GraphQL errors returned with HTTP 200", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					errors: [{ message: "internal server error" }],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		const client = createClient(fetch);

		await expect(
			client.getAccountMetrics(
				"workers-kv-operations",
				"account-id",
				"Account",
				KV_TIME_RANGE,
			),
		).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
	});

	it("throws when the API token is rejected", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		const client = createClient(fetch);

		await expect(
			client.getAccountMetrics(
				"workers-kv-operations",
				"account-id",
				"Account",
				KV_TIME_RANGE,
			),
		).rejects.toThrow(/workers-kv-operations/);
	});
});
