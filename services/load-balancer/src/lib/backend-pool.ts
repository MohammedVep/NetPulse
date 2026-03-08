import type { CircuitBreakerConfig } from "./config.js";
import type { BackendNode, BackendRuntime } from "./types.js";

function nowIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function clampCooldownMs(failures: number, config: CircuitBreakerConfig): number {
  const exponent = Math.max(0, failures - config.openAfterFailures);
  const raw = config.baseCooldownMs * 2 ** exponent;
  return Math.min(config.maxCooldownMs, raw);
}

function cloneBackend(backend: BackendRuntime): BackendRuntime {
  return {
    ...backend,
    metadata: { ...backend.metadata }
  };
}

export class BackendPool {
  private readonly backends = new Map<string, BackendRuntime>();
  private roundRobinCursor = 0;

  constructor(private readonly circuit: CircuitBreakerConfig) {}

  updateFromDiscovery(nodes: BackendNode[], nowMs = Date.now()): void {
    const seen = new Set<string>();

    for (const node of nodes) {
      seen.add(node.id);
      const current = this.backends.get(node.id);

      if (!current) {
        this.backends.set(node.id, {
          ...node,
          metadata: { ...node.metadata },
          discoveredAtIso: nowIso(nowMs),
          lastSeenAtIso: nowIso(nowMs),
          healthy: true,
          circuitState: "CLOSED",
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          inflight: 0
        });
        continue;
      }

      current.host = node.host;
      current.port = node.port;
      current.healthPath = node.healthPath;
      current.metadata = { ...node.metadata };
      current.lastSeenAtIso = nowIso(nowMs);
    }

    for (const existingId of this.backends.keys()) {
      if (seen.has(existingId)) {
        continue;
      }

      this.backends.delete(existingId);
    }

    if (this.backends.size === 0) {
      this.roundRobinCursor = 0;
    }
  }

  listBackends(nowMs = Date.now()): BackendRuntime[] {
    for (const backend of this.backends.values()) {
      this.promoteIfRetryWindowElapsed(backend, nowMs);
    }

    return Array.from(this.backends.values(), (backend) => cloneBackend(backend));
  }

  pickBackend(nowMs = Date.now()): BackendRuntime | undefined {
    const values = Array.from(this.backends.values());

    if (values.length === 0) {
      return undefined;
    }

    for (const backend of values) {
      this.promoteIfRetryWindowElapsed(backend, nowMs);
    }

    const routable = values.filter(
      (backend) =>
        backend.circuitState !== "OPEN" &&
        (backend.healthy || backend.circuitState === "HALF_OPEN") &&
        (backend.circuitState !== "HALF_OPEN" || backend.inflight === 0)
    );

    const degradedFallback = values.filter((backend) => backend.circuitState !== "OPEN");
    const candidates = routable.length > 0 ? routable : degradedFallback;

    if (candidates.length === 0) {
      return undefined;
    }

    const selected = candidates[this.roundRobinCursor % candidates.length];
    this.roundRobinCursor = (this.roundRobinCursor + 1) % Number.MAX_SAFE_INTEGER;

    return selected ? cloneBackend(selected) : undefined;
  }

  incrementInflight(backendId: string): void {
    const backend = this.backends.get(backendId);
    if (!backend) {
      return;
    }

    backend.inflight += 1;
  }

  decrementInflight(backendId: string): void {
    const backend = this.backends.get(backendId);
    if (!backend) {
      return;
    }

    backend.inflight = Math.max(0, backend.inflight - 1);
  }

  recordRequestResult(backendId: string, statusCode: number | undefined, failed: boolean, nowMs = Date.now()): void {
    const backend = this.backends.get(backendId);

    if (!backend) {
      return;
    }

    const isFailure = failed || (statusCode !== undefined && statusCode >= 500);

    if (isFailure) {
      this.registerFailure(backend, nowMs, false);
      return;
    }

    this.registerSuccess(backend, nowMs, false);
  }

  recordHealthResult(backendId: string, healthy: boolean, nowMs = Date.now()): void {
    const backend = this.backends.get(backendId);

    if (!backend) {
      return;
    }

    if (healthy) {
      this.registerSuccess(backend, nowMs, true);
      return;
    }

    this.registerFailure(backend, nowMs, true);
  }

  private promoteIfRetryWindowElapsed(backend: BackendRuntime, nowMs: number): void {
    if (backend.circuitState !== "OPEN" || !backend.nextAttemptAtIso) {
      return;
    }

    const retryAt = Date.parse(backend.nextAttemptAtIso);

    if (Number.isNaN(retryAt) || retryAt > nowMs) {
      return;
    }

    backend.circuitState = "HALF_OPEN";
    delete backend.nextAttemptAtIso;
    backend.consecutiveSuccesses = 0;
  }

  private registerSuccess(backend: BackendRuntime, nowMs: number, fromHealthCheck: boolean): void {
    backend.healthy = true;

    if (fromHealthCheck) {
      backend.lastHealthCheckAtIso = nowIso(nowMs);
    }

    if (backend.circuitState === "OPEN") {
      backend.circuitState = "HALF_OPEN";
      delete backend.nextAttemptAtIso;
      backend.consecutiveSuccesses = 0;
      backend.consecutiveFailures = 0;
    }

    if (backend.circuitState === "HALF_OPEN") {
      backend.consecutiveSuccesses += 1;
      if (backend.consecutiveSuccesses >= this.circuit.halfOpenSuccesses) {
        this.closeCircuit(backend);
      }
      return;
    }

    backend.consecutiveFailures = 0;
    backend.consecutiveSuccesses = 0;
  }

  private registerFailure(backend: BackendRuntime, nowMs: number, fromHealthCheck: boolean): void {
    backend.healthy = false;
    backend.lastFailureAtIso = nowIso(nowMs);

    if (fromHealthCheck) {
      backend.lastHealthCheckAtIso = nowIso(nowMs);
    }

    backend.consecutiveFailures += 1;
    backend.consecutiveSuccesses = 0;

    if (
      backend.circuitState === "HALF_OPEN" ||
      backend.consecutiveFailures >= this.circuit.openAfterFailures
    ) {
      backend.circuitState = "OPEN";
      backend.nextAttemptAtIso = nowIso(nowMs + clampCooldownMs(backend.consecutiveFailures, this.circuit));
    }
  }

  private closeCircuit(backend: BackendRuntime): void {
    backend.circuitState = "CLOSED";
    delete backend.nextAttemptAtIso;
    backend.consecutiveFailures = 0;
    backend.consecutiveSuccesses = 0;
    backend.healthy = true;
  }
}
