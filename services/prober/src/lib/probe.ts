import type { ProbeExecution, ProbeJob } from "./types.js";

async function attemptProbe(job: ProbeJob): Promise<ProbeExecution> {
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
      region: job.region
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";

    return {
      ok: false,
      errorType: isAbort ? "TIMEOUT" : "NETWORK",
      timestampIso: new Date().toISOString(),
      region: job.region
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isSimulationActive(job: ProbeJob): boolean {
  const simulation = job.simulation;
  if (!simulation || simulation.mode === "NONE") {
    return false;
  }

  if (!simulation.until) {
    return true;
  }

  return new Date(simulation.until).getTime() > Date.now();
}

function shouldSimulateFlakyFailure(failureRatePct: number | undefined): boolean {
  const rate = Math.min(100, Math.max(1, failureRatePct ?? 50));
  return Math.random() * 100 < rate;
}

function simulationFailure(job: ProbeJob, errorType: string): ProbeExecution {
  return {
    ok: false,
    errorType,
    timestampIso: new Date().toISOString(),
    region: job.region,
    simulated: true
  };
}

export async function executeProbe(job: ProbeJob): Promise<ProbeExecution> {
  if (isSimulationActive(job) && job.simulation?.mode === "FORCE_FAIL") {
    return simulationFailure(job, "SIMULATED_FORCE_FAIL");
  }

  if (isSimulationActive(job) && job.simulation?.mode === "FLAKY" && shouldSimulateFlakyFailure(job.simulation.failureRatePct)) {
    return simulationFailure(job, "SIMULATED_FLAKY_FAIL");
  }

  const firstAttempt = await attemptProbe(job);

  let result = firstAttempt;

  if (!firstAttempt.ok && firstAttempt.errorType === "TIMEOUT") {
    result = await attemptProbe(job);
  }

  if (isSimulationActive(job) && job.simulation?.mode === "LATENCY_SPIKE" && typeof result.latencyMs === "number") {
    return {
      ...result,
      latencyMs: result.latencyMs + (job.simulation.extraLatencyMs ?? 5000),
      simulated: true
    };
  }

  return result;
}
