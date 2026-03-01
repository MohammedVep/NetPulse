import { afterEach, describe, expect, it, vi } from "vitest";
import { executeProbe } from "./probe.js";

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
    expect(result.timestampIso).toBeTypeOf("string");
  });

  it("marks timeout/network failures as failed checks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network"))
    );

    const result = await executeProbe({
      orgId: "org_1",
      endpointId: "org_1__ep_1",
      url: "https://example.com",
      timeoutMs: 1000,
      region: "us-east-1"
    });

    expect(result.ok).toBe(false);
  });

  it("supports force-fail simulation", async () => {
    const result = await executeProbe({
      orgId: "org_1",
      endpointId: "org_1__ep_1",
      url: "https://example.com",
      timeoutMs: 1000,
      region: "us-east-1",
      simulation: {
        mode: "FORCE_FAIL"
      }
    });

    expect(result.ok).toBe(false);
    expect(result.simulated).toBe(true);
    expect(result.errorType).toBe("SIMULATED_FORCE_FAIL");
  });
});
