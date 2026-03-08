import { describe, expect, it, vi } from "vitest";
import type { LoadBalancerConfig } from "./config.js";
import {
  createDiscoveryClient,
  parseConsulHealthResponse,
  parseEtcdRangeResponse,
  parseStaticBackends
} from "./discovery.js";

function baseConfig(): LoadBalancerConfig {
  return {
    instanceName: "test",
    server: {
      port: 8080,
      requestTimeoutMs: 10_000
    },
    health: {
      intervalMs: 5_000,
      timeoutMs: 1_500,
      defaultPath: "/health"
    },
    circuit: {
      openAfterFailures: 3,
      baseCooldownMs: 1_000,
      maxCooldownMs: 60_000,
      halfOpenSuccesses: 2
    },
    discovery: {
      provider: "static",
      refreshIntervalMs: 5_000,
      staticBackends: "",
      consulUrl: "http://127.0.0.1:8500",
      consulServiceName: "netpulse-backend",
      etcdUrl: "http://127.0.0.1:2379",
      etcdKeyPrefix: "/services/netpulse-backend/"
    }
  };
}

describe("parseStaticBackends", () => {
  it("parses host:port and id=host:port/path entries", () => {
    const parsed = parseStaticBackends(
      "127.0.0.1:3001,blue=127.0.0.1:3002/healthz",
      "/health"
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: "127.0.0.1:3001",
      host: "127.0.0.1",
      port: 3001,
      healthPath: "/health"
    });
    expect(parsed[1]).toMatchObject({
      id: "blue",
      host: "127.0.0.1",
      port: 3002,
      healthPath: "/healthz"
    });
  });
});

describe("parseConsulHealthResponse", () => {
  it("extracts service address, port, and health path metadata", () => {
    const payload = [
      {
        Node: {
          Address: "10.0.0.5"
        },
        Service: {
          ID: "svc-1",
          Service: "netpulse-backend",
          Address: "10.0.0.11",
          Port: 9001,
          Meta: {
            healthPath: "/ready"
          }
        }
      }
    ];

    const parsed = parseConsulHealthResponse(payload, "/health");

    expect(parsed).toEqual([
      {
        id: "svc-1",
        host: "10.0.0.11",
        port: 9001,
        healthPath: "/ready",
        metadata: {
          healthPath: "/ready"
        }
      }
    ]);
  });
});

describe("parseEtcdRangeResponse", () => {
  it("parses backend records from etcd key-values", () => {
    const payload = {
      kvs: [
        {
          key: Buffer.from("/services/netpulse-backend/backend-a").toString("base64"),
          value: Buffer.from(
            JSON.stringify({
              id: "backend-a",
              host: "10.1.0.8",
              port: 9100,
              healthPath: "/alive",
              metadata: {
                zone: "use1-a"
              }
            })
          ).toString("base64")
        }
      ]
    };

    const parsed = parseEtcdRangeResponse(payload, "/health");

    expect(parsed).toEqual([
      {
        id: "backend-a",
        host: "10.1.0.8",
        port: 9100,
        healthPath: "/alive",
        metadata: {
          zone: "use1-a"
        }
      }
    ]);
  });
});

describe("createDiscoveryClient", () => {
  it("calls Consul service health API and parses passing nodes", async () => {
    const config = baseConfig();
    config.discovery.provider = "consul";

    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          Node: {
            Address: "10.0.0.5"
          },
          Service: {
            ID: "svc-2",
            Address: "10.0.0.9",
            Port: 9002,
            Meta: {
              health_path: "/status"
            }
          }
        }
      ]
    });

    const client = createDiscoveryClient(config, fetcher as unknown as typeof fetch);
    const backends = await client.fetchBackends();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(backends).toEqual([
      {
        id: "svc-2",
        host: "10.0.0.9",
        port: 9002,
        healthPath: "/status",
        metadata: {
          health_path: "/status"
        }
      }
    ]);
  });
});
