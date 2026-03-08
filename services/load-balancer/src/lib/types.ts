export type DiscoveryProvider = "static" | "consul" | "etcd";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BackendNode {
  id: string;
  host: string;
  port: number;
  healthPath: string;
  metadata: Record<string, string>;
}

export interface BackendRuntime extends BackendNode {
  discoveredAtIso: string;
  lastSeenAtIso: string;
  lastHealthCheckAtIso?: string;
  lastFailureAtIso?: string;
  healthy: boolean;
  circuitState: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  nextAttemptAtIso?: string;
  inflight: number;
}
