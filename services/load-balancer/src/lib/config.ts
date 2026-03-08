import type { DiscoveryProvider } from "./types.js";

export interface ServerConfig {
  port: number;
  requestTimeoutMs: number;
}

export interface HealthCheckConfig {
  intervalMs: number;
  timeoutMs: number;
  defaultPath: string;
}

export interface CircuitBreakerConfig {
  openAfterFailures: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  halfOpenSuccesses: number;
}

export interface DiscoveryConfig {
  provider: DiscoveryProvider;
  refreshIntervalMs: number;
  staticBackends: string;
  consulUrl: string;
  consulServiceName: string;
  consulDatacenter?: string;
  etcdUrl: string;
  etcdKeyPrefix: string;
}

export interface LoadBalancerConfig {
  instanceName: string;
  server: ServerConfig;
  health: HealthCheckConfig;
  circuit: CircuitBreakerConfig;
  discovery: DiscoveryConfig;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parseProvider(value: string | undefined): DiscoveryProvider {
  if (value === "consul" || value === "etcd" || value === "static") {
    return value;
  }

  return "static";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadBalancerConfig {
  const provider = parseProvider(env.DISCOVERY_PROVIDER);
  const consulDatacenter = env.CONSUL_DATACENTER?.trim();

  return {
    instanceName: env.INSTANCE_NAME?.trim() || "netpulse-lb",
    server: {
      port: parsePositiveInt(env.PORT, 8080),
      requestTimeoutMs: parsePositiveInt(env.LOAD_BALANCER_TIMEOUT_MS, 10_000)
    },
    health: {
      intervalMs: parsePositiveInt(env.HEALTH_CHECK_INTERVAL_MS, 5_000),
      timeoutMs: parsePositiveInt(env.HEALTH_CHECK_TIMEOUT_MS, 1_500),
      defaultPath: env.HEALTH_PATH?.trim() || "/health"
    },
    circuit: {
      openAfterFailures: parsePositiveInt(env.CIRCUIT_OPEN_AFTER_FAILURES, 3),
      baseCooldownMs: parsePositiveInt(env.CIRCUIT_BASE_COOLDOWN_MS, 5_000),
      maxCooldownMs: parsePositiveInt(env.CIRCUIT_MAX_COOLDOWN_MS, 60_000),
      halfOpenSuccesses: parsePositiveInt(env.CIRCUIT_HALF_OPEN_SUCCESSES, 2)
    },
    discovery: {
      provider,
      refreshIntervalMs: parsePositiveInt(env.DISCOVERY_REFRESH_INTERVAL_MS, 5_000),
      staticBackends: env.STATIC_BACKENDS?.trim() || "",
      consulUrl: env.CONSUL_URL?.trim() || "http://127.0.0.1:8500",
      consulServiceName: env.CONSUL_SERVICE_NAME?.trim() || "netpulse-backend",
      ...(consulDatacenter ? { consulDatacenter } : {}),
      etcdUrl: env.ETCD_URL?.trim() || "http://127.0.0.1:2379",
      etcdKeyPrefix: env.ETCD_KEY_PREFIX?.trim() || "/services/netpulse-backend/"
    }
  };
}
