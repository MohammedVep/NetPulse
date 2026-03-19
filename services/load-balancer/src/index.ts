import { createServer } from "node:http";
import { BackendPool } from "./lib/backend-pool.js";
import { loadConfig } from "./lib/config.js";
import { createDiscoveryClient } from "./lib/discovery.js";
import { LoadBalancerMetrics } from "./lib/metrics.js";
import { proxyRequest } from "./lib/proxy.js";
import type { BackendRuntime } from "./lib/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function logInfo(message: string, details?: Record<string, unknown>): void {
  const payload = {
    level: "info",
    timestamp: nowIso(),
    message,
    ...(details ? { details } : {})
  };
  console.log(JSON.stringify(payload));
}

function logError(message: string, details?: Record<string, unknown>): void {
  const payload = {
    level: "error",
    timestamp: nowIso(),
    message,
    ...(details ? { details } : {})
  };
  console.error(JSON.stringify(payload));
}

function healthUrl(backend: BackendRuntime): string {
  return `${backend.protocol}://${backend.host}:${backend.port}${backend.healthPath}`;
}

function isHealthyStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const metrics = new LoadBalancerMetrics();
  const pool = new BackendPool(config.circuit);
  const discovery = createDiscoveryClient(config);

  let discoveryRunning = false;
  let healthChecksRunning = false;

  const refreshDiscovery = async (): Promise<void> => {
    if (discoveryRunning) {
      return;
    }

    discoveryRunning = true;

    try {
      const discovered = await discovery.fetchBackends();
      pool.updateFromDiscovery(discovered);
      metrics.observeDiscovery(config.discovery.provider, true, discovered.length);
      metrics.syncBackendStates(pool.listBackends());
      logInfo("Discovery refresh succeeded", {
        provider: config.discovery.provider,
        count: discovered.length
      });
    } catch (error) {
      metrics.observeDiscovery(config.discovery.provider, false, 0);
      logError("Discovery refresh failed", {
        provider: config.discovery.provider,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      discoveryRunning = false;
    }
  };

  const runHealthChecks = async (): Promise<void> => {
    if (healthChecksRunning) {
      return;
    }

    healthChecksRunning = true;

    try {
      const backends = pool.listBackends();

      await Promise.all(
        backends.map(async (backend) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), config.health.timeoutMs);

          try {
            const response = await fetch(healthUrl(backend), {
              method: "GET",
              redirect: "manual",
              signal: controller.signal
            });

            pool.recordHealthResult(backend.id, isHealthyStatus(response.status));
          } catch {
            pool.recordHealthResult(backend.id, false);
          } finally {
            clearTimeout(timeout);
          }
        })
      );

      metrics.syncBackendStates(pool.listBackends());
    } finally {
      healthChecksRunning = false;
    }
  };

  const server = createServer(async (request, response) => {
    const method = (request.method || "GET").toUpperCase();
    const path = request.url || "/";

    if (method === "GET" && path === "/metrics") {
      response.statusCode = 200;
      response.setHeader("content-type", metrics.contentType());
      response.end(await metrics.render());
      return;
    }

    if (method === "GET" && (path === "/healthz" || path === "/statusz")) {
      const backends = pool.listBackends();
      const healthy = backends.filter((backend) => backend.healthy).length;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "ok",
          provider: config.discovery.provider,
          backends: {
            total: backends.length,
            healthy
          }
        })
      );
      return;
    }

    if (method === "GET" && path === "/backends") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ backends: pool.listBackends() }));
      return;
    }

    const backend = pool.pickBackend();

    if (!backend) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: "No healthy backends are currently available"
        })
      );
      return;
    }

    const started = performance.now();
    pool.incrementInflight(backend.id);
    metrics.incrementInflight(backend.id);

    try {
      const statusCode = await proxyRequest(request, response, backend, config.server.requestTimeoutMs);
      const durationSeconds = (performance.now() - started) / 1000;
      metrics.observeProxyResult(backend.id, method, statusCode, durationSeconds);
      pool.recordRequestResult(backend.id, statusCode, false);
    } catch (error) {
      const durationSeconds = (performance.now() - started) / 1000;
      metrics.observeProxyError(backend.id, method, durationSeconds);
      pool.recordRequestResult(backend.id, undefined, true);

      logError("Upstream proxy request failed", {
        backendId: backend.id,
        error: error instanceof Error ? error.message : "Unknown error"
      });

      if (!response.headersSent) {
        response.statusCode = 502;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: "Bad gateway",
            backendId: backend.id
          })
        );
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      pool.decrementInflight(backend.id);
      metrics.decrementInflight(backend.id);
      metrics.syncBackendStates(pool.listBackends());
    }
  });

  server.keepAliveTimeout = config.server.requestTimeoutMs;
  server.headersTimeout = config.server.requestTimeoutMs + 1_000;

  await refreshDiscovery();
  await runHealthChecks();

  const discoveryTimer = setInterval(() => {
    void refreshDiscovery();
  }, config.discovery.refreshIntervalMs);
  discoveryTimer.unref();

  const healthTimer = setInterval(() => {
    void runHealthChecks();
  }, config.health.intervalMs);
  healthTimer.unref();

  await new Promise<void>((resolve) => {
    server.listen(config.server.port, () => {
      logInfo("NetPulse load balancer started", {
        instance: config.instanceName,
        port: config.server.port,
        discoveryProvider: config.discovery.provider
      });
      resolve();
    });
  });

  const shutdown = (): void => {
    clearInterval(discoveryTimer);
    clearInterval(healthTimer);

    server.close(() => {
      logInfo("NetPulse load balancer stopped");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void bootstrap().catch((error) => {
  logError("Load balancer failed to start", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  process.exit(1);
});
