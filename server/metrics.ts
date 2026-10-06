import { type GlancesResponses, parseGlances } from "../shared/glances";
import type { HostMetrics, HostMetricsBody, HostMetricsHistory } from "../shared/types";

/** Fixed-size window over the most recent items; the oldest drops out when full. */
export function createRing<T>(capacity: number) {
  const items: T[] = [];
  return {
    push(item: T) {
      items.push(item);
      if (items.length > capacity) items.shift();
    },
    /** Oldest first. */
    values: (): readonly T[] => items,
  };
}

type Sample = { at: number; metrics: HostMetrics };

const percentOf = ({ used, total }: { used: number; total: number }) =>
  total > 0 ? (used / total) * 100 : 0;

/** Turns samples into the compact parallel arrays the sparklines read. */
export function toHistory(samples: readonly Sample[]): HostMetricsHistory {
  return {
    at: samples.map((s) => s.at),
    cpu: samples.map((s) => s.metrics.cpuPercent),
    memory: samples.map((s) =>
      percentOf({ used: s.metrics.memory.usedBytes, total: s.metrics.memory.totalBytes }),
    ),
    disk: samples.map((s) =>
      percentOf({ used: s.metrics.disk.usedBytes, total: s.metrics.disk.totalBytes }),
    ),
  };
}

export const sampleIntervalMs = 5_000;
/** 120 samples at 5s: the last 10 minutes. */
export const historySize = 120;
const requestTimeoutMs = 3_000;

/** Reads `GLANCES_URL`; unset or empty means metrics are off. Throws on a malformed URL. */
export function loadGlancesUrl(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.GLANCES_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw new Error(`GLANCES_URL must be an http(s) URL, got "${raw}"`);
  }
}

async function readPlugin(baseUrl: string, plugin: keyof GlancesResponses) {
  const res = await fetch(`${baseUrl}/api/4/${plugin}`, {
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`Glances answered HTTP ${res.status} for ${plugin}`);
  const body: unknown = await res.json();
  return body;
}

async function fetchMetrics(baseUrl: string) {
  const read = (plugin: keyof GlancesResponses) => readPlugin(baseUrl, plugin);
  const [cpu, mem, fs, load, system, uptime, core] = await Promise.all([
    read("cpu"),
    read("mem"),
    read("fs"),
    read("load"),
    read("system"),
    read("uptime"),
    read("core"),
  ]);
  return parseGlances({ cpu, mem, fs, load, system, uptime, core });
}

const describeFailure = (error: unknown) =>
  error instanceof Error && error.name === "TimeoutError"
    ? `Glances did not answer within ${requestTimeoutMs / 1000}s`
    : error instanceof Error
      ? error.message
      : String(error);

/**
 * Polls Glances every 5s and keeps the last 10 minutes in memory. Without a URL nothing
 * runs and every snapshot is `not-configured`. A failed poll keeps the old samples.
 */
export function createHostMetrics(baseUrl: string | undefined) {
  const samples = createRing<Sample>(historySize);
  let failure: string | undefined;

  async function poll(url: string) {
    try {
      samples.push({ at: Date.now(), metrics: await fetchMetrics(url) });
      failure = undefined;
    } catch (error) {
      failure = describeFailure(error);
    }
  }

  // Settles after the first attempt, so a request right after start sees a real answer.
  let firstPoll: Promise<void> = Promise.resolve();
  if (baseUrl) {
    firstPoll = poll(baseUrl);
    setInterval(() => void poll(baseUrl), sampleIntervalMs).unref();
  }

  return {
    async snapshot(): Promise<HostMetricsBody> {
      if (!baseUrl) return { status: "not-configured", metrics: null };
      await firstPoll;
      const latest = samples.values().at(-1);
      const history = toHistory(samples.values());
      const sampledAt = latest ? new Date(latest.at).toISOString() : null;
      if (failure !== undefined) {
        return {
          status: "unreachable",
          metrics: latest?.metrics ?? null,
          sampledAt,
          error: failure,
          history,
        };
      }
      // No failure recorded means at least one poll succeeded.
      if (!latest || !sampledAt) throw new Error("Metrics sampler has no samples");
      return { status: "ok", metrics: latest.metrics, sampledAt, history };
    },
  };
}
