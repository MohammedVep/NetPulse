import { describe, expect, it } from "vitest";
import { buildOrgAiInsights, type EndpointAiSnapshot } from "./ai-insights.js";

function endpoint(partial: Partial<EndpointAiSnapshot>): EndpointAiSnapshot {
  return {
    endpointId: partial.endpointId ?? "ep_1",
    endpointName: partial.endpointName ?? "service-a",
    checks: partial.checks ?? 100,
    failedChecks: partial.failedChecks ?? 0,
    failureRatePct: partial.failureRatePct ?? 0,
    burnRate: partial.burnRate ?? 0,
    avgLatencyMs: partial.avgLatencyMs ?? 120,
    p95LatencyMs: partial.p95LatencyMs ?? 220,
    latencyThresholdMs: partial.latencyThresholdMs ?? 1000
  };
}

describe("buildOrgAiInsights", () => {
  it("returns low risk when endpoints are healthy", () => {
    const insights = buildOrgAiInsights({
      orgId: "org_123",
      window: "24h",
      endpoints: [endpoint({}), endpoint({ endpointId: "ep_2", endpointName: "service-b" })]
    });

    expect(insights.riskLevel).toBe("LOW");
    expect(insights.anomalies).toHaveLength(0);
    expect(insights.topAtRiskEndpoints).toHaveLength(0);
    expect(insights.totals.failureRatePct).toBe(0);
    expect(insights.recommendations[0]).toContain("No significant anomalies");
  });

  it("flags high failure, burn rate, and latency anomalies", () => {
    const insights = buildOrgAiInsights({
      orgId: "org_123",
      window: "24h",
      endpoints: [
        endpoint({
          endpointId: "ep_bad",
          endpointName: "checkout-api",
          checks: 120,
          failedChecks: 36,
          failureRatePct: 30,
          burnRate: 5.2,
          avgLatencyMs: 3200,
          p95LatencyMs: 5200,
          latencyThresholdMs: 1200
        })
      ]
    });

    const anomalyTypes = insights.anomalies.map((item) => item.type);
    expect(anomalyTypes).toContain("FAILURE_RATE");
    expect(anomalyTypes).toContain("BURN_RATE");
    expect(anomalyTypes).toContain("LATENCY");
    expect(insights.topAtRiskEndpoints[0]?.riskScore).toBeGreaterThanOrEqual(80);
    expect(["HIGH", "CRITICAL"]).toContain(insights.riskLevel);
  });

  it("detects no-data coverage gaps", () => {
    const insights = buildOrgAiInsights({
      orgId: "org_123",
      window: "7d",
      endpoints: [endpoint({ endpointId: "ep_empty", checks: 0, failedChecks: 0 })]
    });

    expect(insights.anomalies[0]?.type).toBe("NO_DATA");
    expect(insights.anomalies[0]?.severity).toBe("HIGH");
    expect(insights.totals.checks).toBe(0);
    expect(insights.recommendations.join(" ")).toContain("No probes were collected");
  });
});
