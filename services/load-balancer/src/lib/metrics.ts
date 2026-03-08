import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";
import type { BackendRuntime, CircuitState } from "./types.js";

const CIRCUIT_STATES: CircuitState[] = ["CLOSED", "OPEN", "HALF_OPEN"];

function statusClass(statusCode: number): string {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  if (statusCode >= 200) return "2xx";
  return "other";
}

export class LoadBalancerMetrics {
  private readonly registry = new Registry();
  private readonly knownBackends = new Set<string>();

  private readonly requestCount = new Counter({
    name: "netpulse_lb_requests_total",
    help: "Total proxied requests by backend, method, and status code",
    labelNames: ["backend", "method", "status_code"],
    registers: [this.registry]
  });

  private readonly requestLatency = new Histogram({
    name: "netpulse_lb_request_duration_seconds",
    help: "Upstream request latency",
    labelNames: ["backend", "method", "status_class"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry]
  });

  private readonly activeConnections = new Gauge({
    name: "netpulse_lb_active_connections",
    help: "Current active proxy connections by backend",
    labelNames: ["backend"],
    registers: [this.registry]
  });

  private readonly backendHealthy = new Gauge({
    name: "netpulse_lb_backend_healthy",
    help: "Backend health state (1 = healthy, 0 = unhealthy)",
    labelNames: ["backend"],
    registers: [this.registry]
  });

  private readonly backendCircuit = new Gauge({
    name: "netpulse_lb_backend_circuit_state",
    help: "Circuit state per backend (one-hot labels)",
    labelNames: ["backend", "state"],
    registers: [this.registry]
  });

  private readonly upstream5xx = new Counter({
    name: "netpulse_lb_upstream_5xx_total",
    help: "Total upstream responses with 5xx status",
    labelNames: ["backend"],
    registers: [this.registry]
  });

  private readonly discoveryUpdates = new Counter({
    name: "netpulse_lb_discovery_updates_total",
    help: "Discovery refresh attempts by provider and result",
    labelNames: ["provider", "result"],
    registers: [this.registry]
  });

  private readonly discoveredBackends = new Gauge({
    name: "netpulse_lb_discovered_backends",
    help: "Number of backends returned by discovery",
    labelNames: ["provider"],
    registers: [this.registry]
  });

  private readonly routingBackends = new Gauge({
    name: "netpulse_lb_routing_backends",
    help: "Number of backends currently present in routing table",
    registers: [this.registry]
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: "netpulse_lb_process_"
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  observeDiscovery(provider: string, success: boolean, discoveredCount: number): void {
    this.discoveryUpdates.inc({ provider, result: success ? "success" : "error" });

    if (success) {
      this.discoveredBackends.set({ provider }, discoveredCount);
    }
  }

  observeProxyResult(
    backendId: string,
    method: string,
    statusCode: number,
    durationSeconds: number
  ): void {
    this.requestCount.inc({
      backend: backendId,
      method,
      status_code: String(statusCode)
    });
    this.requestLatency.observe(
      {
        backend: backendId,
        method,
        status_class: statusClass(statusCode)
      },
      durationSeconds
    );

    if (statusCode >= 500) {
      this.upstream5xx.inc({ backend: backendId });
    }
  }

  observeProxyError(backendId: string, method: string, durationSeconds: number): void {
    this.requestCount.inc({
      backend: backendId,
      method,
      status_code: "proxy_error"
    });
    this.requestLatency.observe(
      {
        backend: backendId,
        method,
        status_class: "error"
      },
      durationSeconds
    );
    this.upstream5xx.inc({ backend: backendId });
  }

  incrementInflight(backendId: string): void {
    this.activeConnections.inc({ backend: backendId });
  }

  decrementInflight(backendId: string): void {
    this.activeConnections.dec({ backend: backendId });
  }

  syncBackendStates(backends: BackendRuntime[]): void {
    const current = new Set(backends.map((backend) => backend.id));

    for (const backend of backends) {
      this.knownBackends.add(backend.id);
      this.backendHealthy.set({ backend: backend.id }, backend.healthy ? 1 : 0);
      this.activeConnections.set({ backend: backend.id }, backend.inflight);

      for (const state of CIRCUIT_STATES) {
        this.backendCircuit.set(
          {
            backend: backend.id,
            state
          },
          state === backend.circuitState ? 1 : 0
        );
      }
    }

    for (const known of Array.from(this.knownBackends)) {
      if (current.has(known)) {
        continue;
      }

      this.backendHealthy.remove({ backend: known });
      this.activeConnections.remove({ backend: known });

      for (const state of CIRCUIT_STATES) {
        this.backendCircuit.remove({ backend: known, state });
      }

      this.knownBackends.delete(known);
    }

    this.routingBackends.set(backends.length);
  }
}
