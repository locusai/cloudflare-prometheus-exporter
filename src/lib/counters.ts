import type { MetricDefinition, MetricValue } from "./metrics";
import { metricKey } from "./time";
import type { CounterState } from "./types";

export type CounterProcessingResult = {
	metrics: MetricDefinition[];
	counters: Record<string, CounterState>;
};

export type CounterProcessingOptions = {
	/** Stable identifier for the Cloudflare query window being accumulated. */
	ingestId?: number;
	/** False when replaying a window where absence is not authoritative. */
	ageMissingCounters?: boolean;
	/** Zone labels whose query failed and therefore must not age this refresh. */
	failedScopes?: ReadonlySet<string>;
	/**
	 * Refreshes a series may go unobserved before its accumulated state is
	 * discarded. Must span the longest recording-rule window that reads these
	 * counters, otherwise a quiet series is dropped and restarts from zero,
	 * which Prometheus reads as a counter reset.
	 */
	staleCounterMisses?: number;
};

const DEFAULT_STALE_COUNTER_MISSES = 5;

/**
 * Longest recording-rule window that reads these counters, plus an hour of
 * slack. Prometheus rules over Durable Object and Worker counters use a 24h
 * range, so a series must survive a full day of silence to stay monotonic.
 */
const COUNTER_RETENTION_SECONDS = 25 * 60 * 60;

/**
 * Refreshes a counter may go unobserved before it is discarded, sized so a
 * quiet series outlives the longest recording-rule window that reads it.
 *
 * @param refreshIntervalSeconds Background refresh cadence.
 * @returns Miss budget to pass as `staleCounterMisses`.
 */
export function staleCounterMissesFor(refreshIntervalSeconds: number): number {
	if (!Number.isFinite(refreshIntervalSeconds) || refreshIntervalSeconds <= 0) {
		return DEFAULT_STALE_COUNTER_MISSES;
	}
	return Math.max(
		DEFAULT_STALE_COUNTER_MISSES,
		Math.ceil(COUNTER_RETENTION_SECONDS / refreshIntervalSeconds),
	);
}

function zoneScopeFromMetricKey(key: string): string | undefined {
	return /(?:\{|,)zone=([^,}]*)/.exec(key)?.[1];
}

/**
 * Converts window-based counter observations into accumulated Prometheus counters.
 *
 * @param rawMetrics Metrics returned for the current query window.
 * @param existingCounters Previously accumulated counter state.
 * @param options Query-window and partial-failure context.
 * @returns Metrics ready for export and updated counter state.
 */
export function accumulateCounterMetrics(
	rawMetrics: MetricDefinition[],
	existingCounters: Record<string, CounterState>,
	options: CounterProcessingOptions = {},
): CounterProcessingResult {
	const staleMisses =
		options.staleCounterMisses ?? DEFAULT_STALE_COUNTER_MISSES;
	const counters: Record<string, CounterState> = {};
	const metrics = rawMetrics.map((metric) => {
		if (metric.type !== "counter") {
			return metric;
		}

		const observations = new Map<string, MetricValue>();
		for (const value of metric.values) {
			const key = metricKey(metric.name, value.labels);
			const existing = observations.get(key);
			if (existing === undefined) {
				observations.set(key, { labels: value.labels, value: value.value });
			} else {
				existing.value += value.value;
			}
		}

		const values: MetricValue[] = [];
		for (const [key, value] of observations) {
			const existing = existingCounters[key];
			const alreadyIngested =
				options.ingestId !== undefined &&
				existing?.lastIngest === options.ingestId;
			const accumulated =
				(existing?.accumulated ?? 0) + (alreadyIngested ? 0 : value.value);
			counters[key] = {
				accumulated,
				missesRemaining: staleMisses,
				labels: value.labels,
				...(options.ingestId === undefined
					? {}
					: { lastIngest: options.ingestId }),
				...(value.labels.zone === undefined
					? {}
					: { scope: value.labels.zone }),
			};
			values.push({ labels: value.labels, value: accumulated });
		}

		// Cloudflare omits a series entirely when its query window has no rows.
		// Dropping it from the scrape would leave a staleness gap that
		// increase() cannot bridge, so keep exporting the accumulated total
		// while the series is still retained. Counters must never disappear
		// and never go backwards.
		const keyPrefix = `${metric.name}{`;
		for (const [key, state] of Object.entries(existingCounters)) {
			if (observations.has(key) || !key.startsWith(keyPrefix)) {
				continue;
			}
			if (state.labels === undefined) {
				continue;
			}
			values.push({ labels: state.labels, value: state.accumulated });
		}

		return { ...metric, values };
	});

	for (const [key, state] of Object.entries(existingCounters)) {
		if (Object.hasOwn(counters, key)) {
			continue;
		}

		const scope = state.scope ?? zoneScopeFromMetricKey(key);
		if (
			options.ageMissingCounters === false ||
			(options.failedScopes !== undefined &&
				options.failedScopes.size > 0 &&
				(scope === undefined || options.failedScopes.has(scope)))
		) {
			counters[key] = scope === undefined ? state : { ...state, scope };
			continue;
		}

		const missesRemaining = state.missesRemaining ?? staleMisses;
		if (missesRemaining > 1) {
			counters[key] = {
				...state,
				...(scope === undefined ? {} : { scope }),
				missesRemaining: missesRemaining - 1,
			};
		}
	}

	return { metrics, counters };
}
