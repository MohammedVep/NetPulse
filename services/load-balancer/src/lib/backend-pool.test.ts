import { describe, expect, it } from "vitest";
import { BackendPool } from "./backend-pool.js";

describe("BackendPool", () => {
  it("opens circuit after failures and returns backend after retry window", () => {
    const pool = new BackendPool({
      openAfterFailures: 2,
      baseCooldownMs: 1_000,
      maxCooldownMs: 30_000,
      halfOpenSuccesses: 2
    });

    pool.updateFromDiscovery(
      [
        {
          id: "backend-a",
          host: "127.0.0.1",
          port: 3001,
          healthPath: "/health",
          metadata: {}
        }
      ],
      0
    );

    pool.recordRequestResult("backend-a", 502, false, 100);
    pool.recordRequestResult("backend-a", 502, false, 200);

    const opened = pool.listBackends(200)[0];
    expect(opened?.circuitState).toBe("OPEN");

    expect(pool.pickBackend(900)).toBeUndefined();

    const halfOpenCandidate = pool.pickBackend(1_201);
    expect(halfOpenCandidate?.id).toBe("backend-a");

    pool.recordRequestResult("backend-a", 200, false, 1_202);
    expect(pool.listBackends(1_202)[0]?.circuitState).toBe("HALF_OPEN");

    pool.recordRequestResult("backend-a", 200, false, 1_203);
    expect(pool.listBackends(1_203)[0]?.circuitState).toBe("CLOSED");
  });

  it("selects healthy backends in round-robin order", () => {
    const pool = new BackendPool({
      openAfterFailures: 3,
      baseCooldownMs: 1_000,
      maxCooldownMs: 30_000,
      halfOpenSuccesses: 1
    });

    pool.updateFromDiscovery(
      [
        {
          id: "backend-a",
          host: "127.0.0.1",
          port: 3001,
          healthPath: "/health",
          metadata: {}
        },
        {
          id: "backend-b",
          host: "127.0.0.1",
          port: 3002,
          healthPath: "/health",
          metadata: {}
        }
      ],
      0
    );

    expect(pool.pickBackend(10)?.id).toBe("backend-a");
    expect(pool.pickBackend(20)?.id).toBe("backend-b");
    expect(pool.pickBackend(30)?.id).toBe("backend-a");
  });
});
