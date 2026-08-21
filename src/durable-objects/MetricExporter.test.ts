import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricExporter } from "./MetricExporter";

class AlarmStorage {
	readonly setAlarm = vi.fn().mockResolvedValue(undefined);
	getManyFailures = 0;
	readonly values = new Map<string, unknown>();

	async get(keyOrKeys: string | string[]): Promise<unknown> {
		if (this.getManyFailures > 0) {
			this.getManyFailures--;
			throw new Error("state storage unavailable");
		}
		if (typeof keyOrKeys === "string") return this.values.get(keyOrKeys);
		const result = new Map<string, unknown>();
		for (const key of keyOrKeys) {
			if (this.values.has(key)) result.set(key, this.values.get(key));
		}
		return result;
	}

	async put(entries: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(entries)) {
			this.values.set(key, value);
		}
	}

	async delete(keys: string[]): Promise<void> {
		for (const key of keys) this.values.delete(key);
	}
}

function createExporter(
	storage: AlarmStorage,
	envOverrides: Record<string, unknown> = {},
): {
	exporter: MetricExporter;
	ready: Promise<void>;
} {
	let ready = Promise.resolve();
	const ctx = {
		storage,
		blockConcurrencyWhile(callback: () => Promise<void>) {
			ready = callback();
		},
	};
	const env = {
		LOG_FORMAT: "json",
		LOG_LEVEL: "error",
		...envOverrides,
	};
	return {
		exporter: new MetricExporter(
			ctx as unknown as DurableObjectState,
			env as unknown as Env,
		),
		ready,
	};
}

function storedState(): Record<string, unknown> {
	return {
		scopeType: "account",
		scopeId: "account-id",
		queryName: "worker-totals",
		counters: {},
		metrics: [],
		lastIngest: 0,
		accountId: "account-id",
		accountName: "Account",
		zones: [],
		firewallRules: {},
		zoneMetadata: null,
		refreshInterval: 60,
		lastRefresh: 0,
		lastError: null,
		lastSslFetch: 0,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("MetricExporter state recovery", () => {
	it("schedules recovery when constructor state loading keeps failing", async () => {
		const storage = new AlarmStorage();
		storage.getManyFailures = 2;
		const { exporter, ready } = createExporter(storage);
		await ready;

		await expect(exporter.alarm()).resolves.toBeUndefined();

		expect(storage.setAlarm).toHaveBeenCalledOnce();
	});

	it("backs off only a denied zone chunk while refreshing successful chunks", async () => {
		const storage = new AlarmStorage();
		const zones = Array.from({ length: 11 }, (_, index) => ({
			id: `zone-${index}`,
			name: `zone-${index}.example.com`,
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		}));
		storage.values.set("state", {
			...storedState(),
			queryName: "adaptive-metrics",
			zones,
		});
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
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
				),
			)
			.mockResolvedValue(
				new Response(JSON.stringify({ data: { viewer: { zones: [] } } }), {
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetch);
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const rateLimiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: rateLimiter,
		});
		await ready;

		await exporter.alarm();
		await exporter.alarm();

		expect(fetch).toHaveBeenCalledTimes(3);
		expect(storage.setAlarm).toHaveBeenCalledTimes(2);
		consoleLog.mockRestore();
		vi.unstubAllGlobals();
	});

	it("does not double-count when the platform retries the same alarm window", async () => {
		const storage = new AlarmStorage();
		const zone = {
			id: "zone-id",
			name: "example.com",
			status: "active",
			plan: { id: "paid", name: "Paid" },
			account: { id: "account-id", name: "Account" },
		};
		storage.values.set("state", { ...storedState(), zones: [zone] });
		storage.setAlarm
			.mockRejectedValueOnce(new Error("ordinary alarm scheduling failed"))
			.mockRejectedValueOnce(new Error("recovery alarm scheduling failed"));
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [
										{
											dimensions: { scriptName: "worker" },
											sum: { requests: 42, errors: 0 },
											quantiles: null,
										},
									],
								},
							],
						},
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetch);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const rateLimiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const { exporter, ready } = createExporter(storage, {
			CLOUDFLARE_API_TOKEN: "token",
			CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
			CF_API_RATE_LIMITER: rateLimiter,
		});
		await ready;

		await expect(exporter.alarm()).rejects.toThrow(
			"recovery alarm scheduling failed",
		);
		await exporter.alarm();

		const metrics = await exporter.export();
		const requests = metrics.find(
			(metric) => metric.name === "cloudflare_worker_requests_total",
		);
		expect(requests?.values[0]?.value).toBe(42);
	});

	it("retries a transient constructor load before initialize can overwrite state", async () => {
		const storage = new AlarmStorage();
		storage.getManyFailures = 1;
		storage.values.set("state", storedState());
		const { exporter, ready } = createExporter(storage);
		await ready;

		await exporter.initialize("account:account-id:worker-totals");

		await expect(exporter.export()).resolves.toEqual([]);
	});
});

const KV_OPERATIONS = "cloudflare_worker_kv_operations_total";
const KV_LAST_SUCCESS = "cloudflare_worker_kv_last_success_timestamp_seconds";

const KV_ZONE = {
	id: "zone-id",
	name: "example.com",
	status: "active",
	plan: { id: "paid", name: "Paid" },
	account: { id: "account-id", name: "Account" },
};

function kvResponse(requests: number): Response {
	return new Response(
		JSON.stringify({
			data: {
				viewer: {
					accounts: [
						{
							kvOperationsAdaptiveGroups: [
								{
									dimensions: { namespaceId: "ns-a", actionType: "read" },
									sum: { requests },
								},
							],
						},
					],
				},
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

function kvExporterEnv(fetch: ReturnType<typeof vi.fn>) {
	vi.stubGlobal("fetch", fetch);
	vi.spyOn(console, "log").mockImplementation(() => {});
	return {
		CLOUDFLARE_API_TOKEN: "token",
		CONFIG_KV: { get: vi.fn().mockResolvedValue(null) },
		CF_API_RATE_LIMITER: {
			limit: vi.fn().mockResolvedValue({ success: true }),
		},
	};
}

function kvStorage(): AlarmStorage {
	const storage = new AlarmStorage();
	storage.values.set("state", {
		...storedState(),
		queryName: "workers-kv-operations",
		zones: [KV_ZONE],
	});
	return storage;
}

describe("MetricExporter Workers KV metrics", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("exports KV operations and the last-success gauge", async () => {
		const storage = kvStorage();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(kvResponse(1200));
		const { exporter, ready } = createExporter(storage, kvExporterEnv(fetch));
		await ready;

		await exporter.alarm();

		const metrics = await exporter.export();
		expect(
			metrics.find((metric) => metric.name === KV_OPERATIONS)?.values,
		).toEqual([
			{
				labels: {
					account: "account",
					namespace_id: "ns-a",
					action_type: "read",
				},
				value: 1200,
			},
		]);
		expect(
			metrics.find((metric) => metric.name === KV_LAST_SUCCESS),
		).toBeDefined();
	});

	it("accumulates adjacent windows and ignores a replayed window", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:10:30.000Z"));
		const storage = kvStorage();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async () => kvResponse(100));
		const { exporter, ready } = createExporter(storage, kvExporterEnv(fetch));
		await ready;

		await exporter.alarm();
		// Same minute - same time range, so the window replays and must not count twice.
		await exporter.alarm();
		vi.setSystemTime(new Date("2026-01-01T00:11:30.000Z"));
		await exporter.alarm();

		const metrics = await exporter.export();
		expect(
			metrics.find((metric) => metric.name === KV_OPERATIONS)?.values[0]?.value,
		).toBe(200);
	});

	it("retains cached metrics and the last-success gauge when a refresh fails", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:10:30.000Z"));
		const storage = kvStorage();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(kvResponse(100))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ errors: [{ message: "internal server error" }] }),
					{ headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(kvResponse(50));
		const { exporter, ready } = createExporter(storage, kvExporterEnv(fetch));
		await ready;

		await exporter.alarm();
		const firstTimestamp = (await exporter.export()).find(
			(metric) => metric.name === KV_LAST_SUCCESS,
		)?.values[0]?.value;

		vi.setSystemTime(new Date("2026-01-01T00:11:30.000Z"));
		await exporter.alarm();

		const metrics = await exporter.export();
		expect(
			metrics.find((metric) => metric.name === KV_OPERATIONS)?.values[0]?.value,
		).toBe(100);
		expect(
			metrics.find((metric) => metric.name === KV_LAST_SUCCESS)?.values[0]
				?.value,
		).toBe(firstTimestamp);

		vi.setSystemTime(new Date("2026-01-01T00:12:30.000Z"));
		await exporter.alarm();

		const recoveredMetrics = await exporter.export();
		expect(
			recoveredMetrics.find((metric) => metric.name === KV_OPERATIONS)
				?.values[0]?.value,
		).toBe(150);
		expect(
			recoveredMetrics.find((metric) => metric.name === KV_LAST_SUCCESS)
				?.values[0]?.value,
		).toBeGreaterThan(firstTimestamp ?? 0);
		expect(storage.setAlarm).toHaveBeenCalledTimes(3);
	});
});
