import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT || process.env.BACKEND_PORT || "3001");
const configuredAddress = process.env.BACKEND_ADDRESS;
const serviceName = process.env.CONSUL_SERVICE_NAME || "netpulse-backend";
const serviceId = process.env.CONSUL_SERVICE_ID || `${serviceName}-${randomUUID()}`;
const consulUrl = process.env.CONSUL_URL || "http://127.0.0.1:8500";
const healthPath = process.env.HEALTH_PATH || "/health";
const autoRegister = (process.env.CONSUL_AUTO_REGISTER || "true").toLowerCase() === "true";
let forcedUnhealthy = (process.env.BACKEND_FORCE_UNHEALTHY || "false").toLowerCase() === "true";

function log(message: string, details?: Record<string, unknown>): void {
  const payload = {
    timestamp: new Date().toISOString(),
    message,
    ...(details ? { details } : {})
  };

  console.log(JSON.stringify(payload));
}

async function resolveServiceAddress(): Promise<string> {
  if (configuredAddress && configuredAddress.trim().length > 0) {
    return configuredAddress;
  }

  const metadataUrl = process.env.ECS_CONTAINER_METADATA_URI_V4;

  if (!metadataUrl) {
    return "127.0.0.1";
  }

  try {
    const response = await fetch(`${metadataUrl}/task`);
    if (!response.ok) {
      return "127.0.0.1";
    }

    const payload = (await response.json()) as {
      Containers?: Array<{
        Networks?: Array<{
          IPv4Addresses?: string[];
        }>;
      }>;
    };

    const ip = payload.Containers?.[0]?.Networks?.[0]?.IPv4Addresses?.[0];
    return ip || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

async function registerInConsul(address: string): Promise<void> {
  if (!autoRegister) {
    return;
  }

  const payload = {
    ID: serviceId,
    Name: serviceName,
    Address: address,
    Port: port,
    Meta: {
      healthPath
    },
    Check: {
      HTTP: `http://${address}:${port}${healthPath}`,
      Interval: "5s",
      Timeout: "2s",
      DeregisterCriticalServiceAfter: "1m"
    }
  };

  const response = await fetch(`${consulUrl}/v1/agent/service/register`, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Consul register failed with ${response.status}`);
  }

  log("Backend registered in Consul", {
    serviceName,
    serviceId,
    consulUrl,
    address
  });
}

async function deregisterFromConsul(): Promise<void> {
  if (!autoRegister) {
    return;
  }

  const response = await fetch(`${consulUrl}/v1/agent/service/deregister/${encodeURIComponent(serviceId)}`, {
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Consul deregister failed with ${response.status}`);
  }

  log("Backend deregistered from Consul", {
    serviceId
  });
}

function parseUnhealthyFlag(url: URL): boolean | undefined {
  const query = url.searchParams.get("unhealthy");

  if (query === "true") {
    return true;
  }

  if (query === "false") {
    return false;
  }

  return undefined;
}

async function bootstrap(): Promise<void> {
  const address = await resolveServiceAddress();

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const path = url.pathname;

    if (path === "/admin/failure-mode") {
      const next = parseUnhealthyFlag(url);
      if (next === undefined) {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "Expected ?unhealthy=true|false" }));
        return;
      }

      forcedUnhealthy = next;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          backendId: serviceId,
          unhealthy: forcedUnhealthy
        })
      );
      return;
    }

    if (path === healthPath) {
      response.statusCode = forcedUnhealthy ? 503 : 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: !forcedUnhealthy,
          backendId: serviceId,
          timestamp: new Date().toISOString()
        })
      );
      return;
    }

    response.statusCode = forcedUnhealthy ? 503 : 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        backendId: serviceId,
        serviceName,
        path,
        unhealthy: forcedUnhealthy,
        timestamp: new Date().toISOString()
      })
    );
  });

  server.listen(port, "0.0.0.0", async () => {
    log("Demo backend started", {
      address,
      port,
      healthPath,
      autoRegister
    });

    try {
      await registerInConsul(address);
    } catch (error) {
      log("Consul registration failed", {
        error: error instanceof Error ? error.message : "Unknown error"
      });
      process.exit(1);
    }
  });

  const shutdown = async (): Promise<void> => {
    try {
      await deregisterFromConsul();
    } catch (error) {
      log("Consul deregistration failed", {
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }

    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void bootstrap().catch((error) => {
  log("Backend failed to start", {
    error: error instanceof Error ? error.message : "Unknown error"
  });
  process.exit(1);
});
