import { afterEach, describe, expect, it, vi } from "vitest";
import { circuitOpenProbe, executeProbe } from "./probe.js";

describe("executeProbe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns success response metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200
      })
    );

    const result = await executeProbe({
      orgId: "org_1",
      endpointId: "org_1__ep_1",
      url: "https://example.com",
      timeoutMs: 1000,
      region: "us-east-1"
    });

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.classification).toBe("HTTP_2XX_3XX");
    expect(result.attemptCount).toBe(1);
    expect(result.timestampIso).toBeTypeOf("string");
  });

  it("retries retryable failures with backoff before returning failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeProbe({
      orgId: "org_1",
      endpointId: "org_1__ep_1",
      url: "https://example.com",
      timeoutMs: 1000,
      region: "us-east-1"
    });

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("NETWORK");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("supports force-fail simulation", async () => {
    const result = await executeProbe({
      orgId: "org_1",
      endpointId: "org_1__ep_1",
      url: "https://example.com",
      timeoutMs: 1000,
      region: "us-east-1",
      simulation: {
        mode: "FORCE_FAIL",
        appliedAtIso: new Date().toISOString()
      }
    });

    expect(result.ok).toBe(false);
    expect(result.simulated).toBe(true);
    expect(result.errorType).toBe("SIMULATED_FORCE_FAIL");
    expect(result.classification).toBe("SIMULATED_FORCE_FAIL");
  });

  it("returns synthetic circuit-open failures without a network call", () => {
    const result = circuitOpenProbe({
      orgId: "org_1",
      endpointId: "org_1__ep_1",
      url: "https://example.com",
      timeoutMs: 1000,
      region: "us-east-1"
    });

    expect(result.ok).toBe(false);
    expect(result.classification).toBe("CIRCUIT_OPEN");
    expect(result.errorType).toBe("CIRCUIT_OPEN");
  });
});
