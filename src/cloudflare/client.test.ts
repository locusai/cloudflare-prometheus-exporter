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
		"durable-objects",
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

const WORKER_TIME_RANGE = {
	mintime: "2026-01-01T00:00:00.000Z",
	maxtime: "2026-01-01T00:01:00.000Z",
};

type WorkerTotalsRow = {
	dimensions: {
		scriptName: string;
		status: string;
	} | null;
	sum: { errors: number | null; requests: number | null } | null;
};

function workerRow(
	scriptName: string,
	status: string,
	requests: number,
	errors: number,
): WorkerTotalsRow {
	return {
		dimensions: { scriptName, status },
		sum: { requests, errors },
	};
}

function workerTotalsFetch(rows: WorkerTotalsRow[]): typeof globalThis.fetch {
	return async () =>
		new Response(
			JSON.stringify({
				data: {
					viewer: { accounts: [{ workersInvocationsAdaptive: rows }] },
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
}

const WORKER_REQUESTS = "cloudflare_worker_requests_total";
const WORKER_ERRORS = "cloudflare_worker_errors_total";
const WORKER_LOADSHED = "cloudflare_worker_loadshed_total";

describe("worker-totals", () => {
	it("separates load-shed rejections from genuine script errors", async () => {
		const client = createClient(
			workerTotalsFetch([
				workerRow("script-a", "success", 100, 0),
				workerRow("script-a", "loadShed", 40, 40),
				workerRow("script-a", "scriptThrewException", 3, 3),
				workerRow("script-a", "clientDisconnected", 7, 0),
			]),
		);

		const metrics = await client.getAccountMetrics(
			"worker-totals",
			"account-id",
			"Account",
			WORKER_TIME_RANGE,
		);

		const labels = { account: "account", script_name: "script-a" };
		expect(findMetric(metrics, WORKER_REQUESTS)?.values).toEqual([
			{ labels, value: 100 },
			{ labels, value: 40 },
			{ labels, value: 3 },
			{ labels, value: 7 },
		]);
		expect(findMetric(metrics, WORKER_ERRORS)?.values).toEqual([
			{ labels, value: 0 },
			{ labels, value: 0 },
			{ labels, value: 3 },
			{ labels, value: 0 },
		]);
		expect(findMetric(metrics, WORKER_LOADSHED)?.values).toEqual([
			{ labels, value: 0 },
			{ labels, value: 40 },
			{ labels, value: 0 },
			{ labels, value: 0 },
		]);
	});

	it("keeps both error series alive for a script whose only rows are load-shed", async () => {
		const client = createClient(
			workerTotalsFetch([workerRow("script-b", "loadShed", 12, 12)]),
		);

		const metrics = await client.getAccountMetrics(
			"worker-totals",
			"account-id",
			"Account",
			WORKER_TIME_RANGE,
		);

		const labels = { account: "account", script_name: "script-b" };
		expect(findMetric(metrics, WORKER_ERRORS)?.values).toEqual([
			{ labels, value: 0 },
		]);
		expect(findMetric(metrics, WORKER_LOADSHED)?.values).toEqual([
			{ labels, value: 12 },
		]);
	});
});

const DO_TIME_RANGE = {
	mintime: "2026-01-01T00:00:00.000Z",
	maxtime: "2026-01-01T00:01:00.000Z",
};

type InvocationGroup = {
	dimensions: {
		namespaceId: string;
		scriptName: string;
		status: string;
	} | null;
	sum: { errors: number | null; requests: number | null } | null;
};

type PeriodicGroup = {
	dimensions: { namespaceId: string } | null;
	sum: {
		cpuTime: number | null;
		duration: number | null;
		exceededCpuErrors: number | null;
		exceededMemoryErrors: number | null;
		rowsRead: number | null;
		rowsWritten: number | null;
	} | null;
	max: { activeWebsocketConnections: number | null } | null;
};

type SqlStorageGroup = {
	dimensions: { namespaceId: string } | null;
	max: { storedBytes: number | null } | null;
};

function invocationGroup(
	namespaceId: string,
	scriptName: string,
	status: string,
	requests: number,
	errors: number,
): InvocationGroup {
	return {
		dimensions: { namespaceId, scriptName, status },
		sum: { requests, errors },
	};
}

function periodicGroup(
	namespaceId: string,
	sum: {
		cpuTime?: number;
		duration?: number;
		exceededCpuErrors?: number;
		exceededMemoryErrors?: number;
		rowsRead?: number;
		rowsWritten?: number;
	},
	activeWebsocketConnections?: number,
): PeriodicGroup {
	return {
		dimensions: { namespaceId },
		sum: {
			cpuTime: sum.cpuTime ?? null,
			duration: sum.duration ?? null,
			exceededCpuErrors: sum.exceededCpuErrors ?? null,
			exceededMemoryErrors: sum.exceededMemoryErrors ?? null,
			rowsRead: sum.rowsRead ?? null,
			rowsWritten: sum.rowsWritten ?? null,
		},
		max:
			activeWebsocketConnections == null
				? null
				: { activeWebsocketConnections },
	};
}

function sqlStorageGroup(
	namespaceId: string,
	storedBytes: number,
): SqlStorageGroup {
	return { dimensions: { namespaceId }, max: { storedBytes } };
}

function doFetch(
	invocations: InvocationGroup[],
	periodic: PeriodicGroup[],
	sqlStorage: SqlStorageGroup[],
): typeof globalThis.fetch {
	return async () =>
		new Response(
			JSON.stringify({
				data: {
					viewer: {
						accounts: [
							{
								durableObjectsInvocationsAdaptiveGroups: invocations,
								durableObjectsPeriodicGroups: periodic,
								durableObjectsSqlStorageGroups: sqlStorage,
							},
						],
					},
				},
			}),
			{ headers: { "content-type": "application/json" } },
		);
}

const DO_REQUESTS = "cloudflare_durable_object_requests_total";
const DO_ERRORS = "cloudflare_durable_object_errors_total";
const DO_CPU_TIME = "cloudflare_durable_object_cpu_time_seconds_total";
const DO_DURATION = "cloudflare_durable_object_duration_gb_seconds_total";
const DO_ROWS_READ = "cloudflare_durable_object_rows_read_total";
const DO_ROWS_WRITTEN = "cloudflare_durable_object_rows_written_total";
const DO_EXCEEDED_CPU = "cloudflare_durable_object_exceeded_cpu_errors_total";
const DO_EXCEEDED_MEMORY =
	"cloudflare_durable_object_exceeded_memory_errors_total";
const DO_ACTIVE_WS = "cloudflare_durable_object_active_websocket_connections";
const DO_SQLITE_BYTES = "cloudflare_durable_object_sqlite_stored_bytes";
const DO_LAST_SUCCESS =
	"cloudflare_durable_object_last_success_timestamp_seconds";

describe("durable-objects", () => {
	it("maps requests and errors across multiple namespaces and scripts", async () => {
		const client = createClient(
			doFetch(
				[
					invocationGroup("ns-a", "script-a", "success", 100, 2),
					invocationGroup("ns-b", "script-b", "exception", 5, 5),
				],
				[],
				[],
			),
		);

		const metrics = await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		const requests = findMetric(metrics, DO_REQUESTS);
		expect(requests?.type).toBe("counter");
		expect(requests?.values).toEqual([
			{
				labels: {
					account: "account",
					namespace_id: "ns-a",
					script_name: "script-a",
					status: "success",
				},
				value: 100,
			},
			{
				labels: {
					account: "account",
					namespace_id: "ns-b",
					script_name: "script-b",
					status: "exception",
				},
				value: 5,
			},
		]);

		const errors = findMetric(metrics, DO_ERRORS);
		expect(errors?.type).toBe("counter");
		expect(errors?.values).toEqual([
			{
				labels: {
					account: "account",
					namespace_id: "ns-a",
					script_name: "script-a",
					status: "success",
				},
				value: 2,
			},
			{
				labels: {
					account: "account",
					namespace_id: "ns-b",
					script_name: "script-b",
					status: "exception",
				},
				value: 5,
			},
		]);
	});

	it("converts CPU time from microseconds to seconds and passes duration through unchanged", async () => {
		const client = createClient(
			doFetch(
				[],
				[periodicGroup("ns-a", { cpuTime: 2_500_000, duration: 12.5 })],
				[],
			),
		);

		const metrics = await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		expect(findMetric(metrics, DO_CPU_TIME)?.values).toEqual([
			{ labels: { account: "account", namespace_id: "ns-a" }, value: 2.5 },
		]);
		expect(findMetric(metrics, DO_DURATION)?.values).toEqual([
			{ labels: { account: "account", namespace_id: "ns-a" }, value: 12.5 },
		]);
	});

	it("maps rows read/written, exceeded errors, and active websocket connections", async () => {
		const client = createClient(
			doFetch(
				[],
				[
					periodicGroup(
						"ns-a",
						{
							rowsRead: 900,
							rowsWritten: 40,
							exceededCpuErrors: 3,
							exceededMemoryErrors: 1,
						},
						12,
					),
				],
				[],
			),
		);

		const metrics = await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		const labels = { account: "account", namespace_id: "ns-a" };
		expect(findMetric(metrics, DO_ROWS_READ)?.values).toEqual([
			{ labels, value: 900 },
		]);
		expect(findMetric(metrics, DO_ROWS_WRITTEN)?.values).toEqual([
			{ labels, value: 40 },
		]);
		expect(findMetric(metrics, DO_EXCEEDED_CPU)?.values).toEqual([
			{ labels, value: 3 },
		]);
		expect(findMetric(metrics, DO_EXCEEDED_MEMORY)?.values).toEqual([
			{ labels, value: 1 },
		]);

		const activeWs = findMetric(metrics, DO_ACTIVE_WS);
		expect(activeWs?.type).toBe("gauge");
		expect(activeWs?.values).toEqual([{ labels, value: 12 }]);
	});

	it("reports SQLite stored bytes as a gauge, not a counter", async () => {
		const client = createClient(
			doFetch([], [], [sqlStorageGroup("ns-a", 4096)]),
		);

		const metrics = await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		const storedBytes = findMetric(metrics, DO_SQLITE_BYTES);
		expect(storedBytes?.type).toBe("gauge");
		expect(storedBytes?.values).toEqual([
			{ labels: { account: "account", namespace_id: "ns-a" }, value: 4096 },
		]);
	});

	it("updates the last-success gauge on a successful empty response", async () => {
		const client = createClient(doFetch([], [], []));
		const before = Math.floor(Date.now() / 1000);

		const metrics = await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		expect(metrics).toEqual([
			expect.objectContaining({ name: DO_LAST_SUCCESS }),
		]);

		const lastSuccess = findMetric(metrics, DO_LAST_SUCCESS);
		expect(lastSuccess?.type).toBe("gauge");
		expect(lastSuccess?.values[0]?.value).toBeGreaterThanOrEqual(before);
	});

	it("skips groups with null dimensions or null sum fields instead of reporting zero", async () => {
		const client = createClient(
			doFetch(
				[
					{ dimensions: null, sum: { requests: 3, errors: 1 } },
					{
						dimensions: { namespaceId: "ns-a", scriptName: "s", status: "ok" },
						sum: null,
					},
					invocationGroup("ns-b", "script-b", "ok", 9, 0),
				],
				[
					{ dimensions: null, sum: null, max: null },
					periodicGroup("ns-c", { rowsRead: 1 }),
				],
				[
					{ dimensions: null, max: { storedBytes: 10 } },
					{ dimensions: { namespaceId: "ns-d" }, max: null },
				],
			),
		);

		const metrics = await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		expect(findMetric(metrics, DO_REQUESTS)?.values).toEqual([
			{
				labels: {
					account: "account",
					namespace_id: "ns-b",
					script_name: "script-b",
					status: "ok",
				},
				value: 9,
			},
		]);
		expect(findMetric(metrics, DO_ROWS_READ)?.values).toEqual([
			{ labels: { account: "account", namespace_id: "ns-c" }, value: 1 },
		]);
		expect(findMetric(metrics, DO_SQLITE_BYTES)).toBeUndefined();
	});

	it("rejects a result that reaches the query limit on any dataset", async () => {
		const client = createClient(
			doFetch(
				[
					invocationGroup("ns-a", "script-a", "ok", 1, 0),
					invocationGroup("ns-b", "script-b", "ok", 2, 0),
				],
				[],
				[],
			),
			2,
		);

		await expect(
			client.getAccountMetrics(
				"durable-objects",
				"account-id",
				"Account",
				DO_TIME_RANGE,
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
				"durable-objects",
				"account-id",
				"Account",
				DO_TIME_RANGE,
			),
		).rejects.toThrow("expected 1");
	});

	it("throws on GraphQL errors returned with HTTP 200", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				JSON.stringify({ errors: [{ message: "internal server error" }] }),
				{ headers: { "content-type": "application/json" } },
			);
		const client = createClient(fetch);

		await expect(
			client.getAccountMetrics(
				"durable-objects",
				"account-id",
				"Account",
				DO_TIME_RANGE,
			),
		).rejects.toMatchObject({ code: ErrorCode.GRAPHQL_ERROR });
	});

	it("never requests the Durable Object ID", async () => {
		let body: string | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			body = init?.body as string;
			return new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									durableObjectsInvocationsAdaptiveGroups: [],
									durableObjectsPeriodicGroups: [],
									durableObjectsSqlStorageGroups: [],
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		const client = createClient(fetch);

		await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		const request = JSON.parse(body ?? "{}");
		expect(request.query).not.toContain("objectId");
	});

	it("queries the exact half-open time window for each dataset", async () => {
		let body: string | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			body = init?.body as string;
			return new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									durableObjectsInvocationsAdaptiveGroups: [],
									durableObjectsPeriodicGroups: [],
									durableObjectsSqlStorageGroups: [],
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		const client = createClient(fetch, 5000);

		await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		const request = JSON.parse(body ?? "{}");
		expect(request.variables).toEqual({
			accountID: "account-id",
			mintime: DO_TIME_RANGE.mintime,
			maxtime: DO_TIME_RANGE.maxtime,
			storageMintime: "2025-12-31T00:01:00.000Z",
			limit: 5000,
		});
		expect(request.query).toContain("datetime_geq: $mintime");
		expect(request.query).toContain("datetimeMinute_geq: $mintime");
		expect(request.query).toContain("datetimeMinute_lt: $maxtime");
	});

	it("looks back further for SQLite storage than the standard scrape window", async () => {
		let body: string | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			body = init?.body as string;
			return new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									durableObjectsInvocationsAdaptiveGroups: [],
									durableObjectsPeriodicGroups: [],
									durableObjectsSqlStorageGroups: [
										sqlStorageGroup("ns-a", 4096),
									],
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		};
		const client = createClient(fetch);

		await client.getAccountMetrics(
			"durable-objects",
			"account-id",
			"Account",
			DO_TIME_RANGE,
		);

		const request = JSON.parse(body ?? "{}");
		expect(request.query).toContain("datetimeHour_geq: $storageMintime");
		expect(request.query).toContain("datetimeHour_lt: $maxtime");
		expect(new Date(request.variables.storageMintime).getTime()).toBe(
			new Date(DO_TIME_RANGE.maxtime).getTime() - 24 * 60 * 60 * 1000,
		);
	});
});
