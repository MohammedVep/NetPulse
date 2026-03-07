import type { ProbeExecution, ProbeJob } from "./types.js";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 1_200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyProbeResult(result: ProbeExecution): NonNullable<ProbeExecution["classification"]> {
  if (result.errorType === "SIMULATED_FORCE_FAIL") {
    return "SIMULATED_FORCE_FAIL";
  }

  if (result.errorType === "SIMULATED_FORCE_DEGRADED") {
    return "SIMULATED_FORCE_DEGRADED";
  }

  if (result.errorType === "TIMEOUT") {
    return "TIMEOUT";
  }

  if (result.errorType === "NETWORK") {
    return "NETWORK";
  }

  if (result.errorType === "CIRCUIT_OPEN") {
    return "CIRCUIT_OPEN";
  }

  if ((result.statusCode ?? 0) >= 500) {
    return "HTTP_5XX";
  }

  if ((result.statusCode ?? 0) >= 400) {
    return "HTTP_4XX";
  }

  return "HTTP_2XX_3XX";
}

function isRetryable(result: ProbeExecution): boolean {
  if (result.ok) {
    return false;
  }

  return (
    result.errorType === "TIMEOUT" ||
    result.errorType === "NETWORK" ||
    ((result.statusCode ?? 0) >= 500 && (result.statusCode ?? 0) <= 599)
  );
}

function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 100);
  return exp + jitter;
}

async function attemptProbe(job: ProbeJob, attempt: number): Promise<ProbeExecution> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), job.timeoutMs);

  try {
    const response = await fetch(job.url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "NetPulseProbe/1.0"
      }
    });

    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    return {
      ok: response.status >= 200 && response.status < 400,
      statusCode: response.status,
      latencyMs,
      timestampIso: new Date().toISOString(),
      region: job.region,
      attemptCount: attempt,
      ...(job.traceId ? { traceId: job.traceId } : {})
    };
  } catch (error) {
    const isAbort =
      (error instanceof DOMException && error.name === "AbortError") ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        String((error as { name?: string }).name) === "AbortError");

    return {
      ok: false,
      errorType: isAbort ? "TIMEOUT" : "NETWORK",
      timestampIso: new Date().toISOString(),
      region: job.region,
      attemptCount: attempt,
      ...(job.traceId ? { traceId: job.traceId } : {})
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isSimulationActive(job: ProbeJob): boolean {
  const simulation = job.simulation;
  if (!simulation) {
    return false;
  }

  if (!simulation.expiresAtIso) {
    return true;
  }

  return new Date(simulation.expiresAtIso).getTime() > Date.now();
}

function simulationFailure(job: ProbeJob): ProbeExecution {
  const failureStatusCode = job.simulation?.failureStatusCode ?? 503;
  const result: ProbeExecution = {
    ok: false,
    statusCode: failureStatusCode,
    errorType: "SIMULATED_FORCE_FAIL",
    timestampIso: new Date().toISOString(),
    region: job.region,
    simulated: true,
    simulationMode: "FORCE_FAIL",
    attemptCount: 1,
    ...(job.traceId ? { traceId: job.traceId } : {})
  };

  return {
    ...result,
    classification: classifyProbeResult(result)
  };
}

export function circuitOpenProbe(job: ProbeJob): ProbeExecution {
  const result: ProbeExecution = {
    ok: false,
    errorType: "CIRCUIT_OPEN",
    timestampIso: new Date().toISOString(),
    region: job.region,
    attemptCount: 0,
    ...(job.traceId ? { traceId: job.traceId } : {})
  };

  return {
    ...result,
    classification: "CIRCUIT_OPEN"
  };
}

export async function executeProbe(job: ProbeJob): Promise<ProbeExecution> {
  if (isSimulationActive(job) && job.simulation?.mode === "FORCE_FAIL") {
    return simulationFailure(job);
  }

  let result: ProbeExecution | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    result = await attemptProbe(job, attempt);

    if (!isRetryable(result) || attempt === MAX_ATTEMPTS) {
      break;
    }

    await sleep(backoffMs(attempt));
  }

  const resolvedResult =
    result ??
    ({
      ok: false,
      errorType: "NETWORK",
      timestampIso: new Date().toISOString(),
      region: job.region,
      attemptCount: MAX_ATTEMPTS,
      ...(job.traceId ? { traceId: job.traceId } : {})
    } satisfies ProbeExecution);

  if (isSimulationActive(job) && job.simulation?.mode === "FORCE_DEGRADED") {
    const baseLatency = resolvedResult.latencyMs ?? 1;
    const degraded: ProbeExecution = {
      ...resolvedResult,
      ok: true,
      statusCode: resolvedResult.statusCode ?? 200,
      latencyMs: baseLatency + (job.simulation.forcedLatencyMs ?? 2500),
      simulated: true,
      simulationMode: "FORCE_DEGRADED",
      errorType: "SIMULATED_FORCE_DEGRADED"
    };

    return {
      ...degraded,
      classification: classifyProbeResult(degraded)
    };
  }

  return {
    ...resolvedResult,
    classification: classifyProbeResult(resolvedResult)
  };
}
