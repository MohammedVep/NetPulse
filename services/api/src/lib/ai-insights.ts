import type {
  AiAnomalySeverity,
  AiRiskLevel,
  MetricsWindow,
  OrgAiEndpointAnomaly,
  OrgAiEndpointRisk,
  OrgAiInsights
} from "@netpulse/shared";

const DEFAULT_MODEL = "netpulse-risk-v1";
const HIGH_FAILURE_RATE_PCT = 20;
const MEDIUM_FAILURE_RATE_PCT = 5;
const HIGH_BURN_RATE = 4;
const MEDIUM_BURN_RATE = 2;

export interface EndpointAiSnapshot {
  endpointId: string;
  endpointName: string;
  checks: number;
  failedChecks: number;
  failureRatePct: number;
  burnRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  latencyThresholdMs: number;
}

export interface BuildOrgAiInsightsInput {
  orgId: string;
  window: MetricsWindow;
  generatedAt?: string;
  model?: string;
  endpoints: EndpointAiSnapshot[];
}

function normalizePercent(value: number): number {
  return Number(value.toFixed(2));
}

function severityWeight(severity: AiAnomalySeverity): number {
  if (severity === "HIGH") return 3;
  if (severity === "MEDIUM") return 2;
  return 1;
}

function toRiskLevel(topRiskScore: number, highCount: number, mediumCount: number): AiRiskLevel {
  if (topRiskScore >= 80 || highCount >= 3) return "CRITICAL";
  if (topRiskScore >= 60 || highCount >= 1) return "HIGH";
  if (topRiskScore >= 30 || mediumCount >= 2) return "MEDIUM";
  return "LOW";
}

function getEndpointAnomalies(snapshot: EndpointAiSnapshot): OrgAiEndpointAnomaly[] {
  const anomalies: OrgAiEndpointAnomaly[] = [];

  if (snapshot.checks === 0) {
    anomalies.push({
      endpointId: snapshot.endpointId,
      endpointName: snapshot.endpointName,
      type: "NO_DATA",
      severity: "HIGH",
      message: "No probe data in selected window",
      checks: snapshot.checks,
      failureRatePct: snapshot.failureRatePct,
      burnRate: snapshot.burnRate,
      avgLatencyMs: snapshot.avgLatencyMs,
      p95LatencyMs: snapshot.p95LatencyMs
    });
    return anomalies;
  }

  if (snapshot.failureRatePct >= MEDIUM_FAILURE_RATE_PCT) {
    const severity: AiAnomalySeverity =
      snapshot.failureRatePct >= HIGH_FAILURE_RATE_PCT ? "HIGH" : "MEDIUM";
    anomalies.push({
      endpointId: snapshot.endpointId,
      endpointName: snapshot.endpointName,
      type: "FAILURE_RATE",
      severity,
      message: `Failure rate ${snapshot.failureRatePct}% is above threshold`,
      checks: snapshot.checks,
      failureRatePct: snapshot.failureRatePct,
      burnRate: snapshot.burnRate,
      avgLatencyMs: snapshot.avgLatencyMs,
      p95LatencyMs: snapshot.p95LatencyMs
    });
  }

  if (snapshot.burnRate >= MEDIUM_BURN_RATE) {
    const severity: AiAnomalySeverity = snapshot.burnRate >= HIGH_BURN_RATE ? "HIGH" : "MEDIUM";
    anomalies.push({
      endpointId: snapshot.endpointId,
      endpointName: snapshot.endpointName,
      type: "BURN_RATE",
      severity,
      message: `Error budget burn rate is ${snapshot.burnRate}x`,
      checks: snapshot.checks,
      failureRatePct: snapshot.failureRatePct,
      burnRate: snapshot.burnRate,
      avgLatencyMs: snapshot.avgLatencyMs,
      p95LatencyMs: snapshot.p95LatencyMs
    });
  }

  if (snapshot.avgLatencyMs > snapshot.latencyThresholdMs) {
    const severity: AiAnomalySeverity =
      snapshot.avgLatencyMs >= snapshot.latencyThresholdMs * 1.5 ? "HIGH" : "MEDIUM";
    anomalies.push({
      endpointId: snapshot.endpointId,
      endpointName: snapshot.endpointName,
      type: "LATENCY",
      severity,
      message: `Average latency ${snapshot.avgLatencyMs}ms exceeds ${snapshot.latencyThresholdMs}ms`,
      checks: snapshot.checks,
      failureRatePct: snapshot.failureRatePct,
      burnRate: snapshot.burnRate,
      avgLatencyMs: snapshot.avgLatencyMs,
      p95LatencyMs: snapshot.p95LatencyMs
    });
  }

  return anomalies;
}

function getEndpointRisk(snapshot: EndpointAiSnapshot): OrgAiEndpointRisk {
  let riskScore = 0;
  const reasons: string[] = [];

  if (snapshot.checks === 0) {
    riskScore += 65;
    reasons.push("No probe data in selected window");
  }

  if (snapshot.failureRatePct >= HIGH_FAILURE_RATE_PCT) {
    riskScore += 40;
    reasons.push(`Failure rate ${snapshot.failureRatePct}%`);
  } else if (snapshot.failureRatePct >= MEDIUM_FAILURE_RATE_PCT) {
    riskScore += 20;
    reasons.push(`Failure rate ${snapshot.failureRatePct}%`);
  } else if (snapshot.failureRatePct >= 1) {
    riskScore += 8;
  }

  if (snapshot.burnRate >= HIGH_BURN_RATE) {
    riskScore += 35;
    reasons.push(`Burn rate ${snapshot.burnRate}x`);
  } else if (snapshot.burnRate >= MEDIUM_BURN_RATE) {
    riskScore += 18;
    reasons.push(`Burn rate ${snapshot.burnRate}x`);
  }

  if (snapshot.avgLatencyMs >= snapshot.latencyThresholdMs * 1.5) {
    riskScore += 25;
    reasons.push(`Average latency ${snapshot.avgLatencyMs}ms`);
  } else if (snapshot.avgLatencyMs > snapshot.latencyThresholdMs) {
    riskScore += 12;
    reasons.push(`Average latency ${snapshot.avgLatencyMs}ms`);
  }

  if (snapshot.p95LatencyMs > snapshot.latencyThresholdMs * 2) {
    riskScore += 8;
  }

  return {
    endpointId: snapshot.endpointId,
    endpointName: snapshot.endpointName,
    riskScore: Math.min(100, Math.round(riskScore)),
    reasons
  };
}

function buildRecommendations(
  anomalies: OrgAiEndpointAnomaly[],
  topAtRiskEndpoints: OrgAiEndpointRisk[],
  totalChecks: number
): string[] {
  const recommendations: string[] = [];
  const push = (message: string) => {
    if (!recommendations.includes(message)) {
      recommendations.push(message);
    }
  };

  if (totalChecks === 0) {
    push("No probes were collected. Verify scheduler, queue depth, and worker concurrency.");
  }

  if (anomalies.some((anomaly) => anomaly.type === "NO_DATA")) {
    push("Investigate ingestion gaps for endpoints with no telemetry in this window.");
  }

  if (anomalies.some((anomaly) => anomaly.type === "FAILURE_RATE")) {
    push("Reduce failure rates by validating upstream dependencies and timeout policies.");
  }

  if (anomalies.some((anomaly) => anomaly.type === "BURN_RATE")) {
    push("Burn rate is elevated. Consider rollback, traffic shaping, or temporary alert escalation.");
  }

  if (anomalies.some((anomaly) => anomaly.type === "LATENCY")) {
    push("Latency is above threshold. Compare region-level performance and scale bottleneck services.");
  }

  if ((topAtRiskEndpoints[0]?.riskScore ?? 0) >= 80) {
    push("Immediate mitigation is recommended for the highest-risk endpoints.");
  }

  if (recommendations.length === 0) {
    push("No significant anomalies detected in this window.");
  }

  return recommendations.slice(0, 5);
}

function buildSummary(
  endpointCount: number,
  totalChecks: number,
  anomalies: OrgAiEndpointAnomaly[],
  riskLevel: AiRiskLevel
): string {
  if (endpointCount === 0) {
    return "No active endpoints found for analysis.";
  }

  if (anomalies.length === 0) {
    return `Analyzed ${endpointCount} endpoints across ${totalChecks} checks. No anomalies detected.`;
  }

  const highCount = anomalies.filter((anomaly) => anomaly.severity === "HIGH").length;
  return `Analyzed ${endpointCount} endpoints across ${totalChecks} checks with ${anomalies.length} anomalies (${highCount} high). Overall risk ${riskLevel}.`;
}

export function buildOrgAiInsights(input: BuildOrgAiInsightsInput): OrgAiInsights {
  const endpoints = input.endpoints;
  const anomalies = endpoints
    .flatMap((endpoint) => getEndpointAnomalies(endpoint))
    .sort((a, b) => {
      const severity = severityWeight(b.severity) - severityWeight(a.severity);
      if (severity !== 0) return severity;
      if (b.failureRatePct !== a.failureRatePct) return b.failureRatePct - a.failureRatePct;
      if (b.burnRate !== a.burnRate) return b.burnRate - a.burnRate;
      return b.avgLatencyMs - a.avgLatencyMs;
    });

  const endpointRisks = endpoints
    .map((endpoint) => getEndpointRisk(endpoint))
    .filter((risk) => risk.riskScore > 0)
    .sort((a, b) => b.riskScore - a.riskScore);

  const totalChecks = endpoints.reduce((sum, endpoint) => sum + endpoint.checks, 0);
  const failedChecks = endpoints.reduce((sum, endpoint) => sum + endpoint.failedChecks, 0);
  const failureRatePct = totalChecks > 0 ? normalizePercent((failedChecks / totalChecks) * 100) : 0;
  const avgBurnRate =
    endpoints.length > 0
      ? normalizePercent(endpoints.reduce((sum, endpoint) => sum + endpoint.burnRate, 0) / endpoints.length)
      : 0;

  const highCount = anomalies.filter((anomaly) => anomaly.severity === "HIGH").length;
  const mediumCount = anomalies.filter((anomaly) => anomaly.severity === "MEDIUM").length;
  const topRiskScore = endpointRisks[0]?.riskScore ?? 0;
  const riskLevel = toRiskLevel(topRiskScore, highCount, mediumCount);
  const recommendations = buildRecommendations(anomalies, endpointRisks, totalChecks);
  const summary = buildSummary(endpoints.length, totalChecks, anomalies, riskLevel);

  return {
    orgId: input.orgId,
    window: input.window,
    model: input.model ?? DEFAULT_MODEL,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    riskLevel,
    summary,
    totals: {
      endpoints: endpoints.length,
      checks: totalChecks,
      failedChecks,
      failureRatePct,
      avgBurnRate
    },
    anomalies,
    recommendations,
    topAtRiskEndpoints: endpointRisks.slice(0, 5)
  };
}
