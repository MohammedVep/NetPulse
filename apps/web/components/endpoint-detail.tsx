"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Endpoint,
  IncidentTimeline,
  EndpointMetrics,
  OrgAiEndpointAnomaly,
  OrgAiInsights,
  EndpointSlaReport,
  ProbeResult
} from "../../../packages/shared/src/types";
import { apiClient, hasAuthToken } from "@/lib/netpulse-client";

interface EndpointDetailProps {
  endpointId: string;
}

type RiskWindow = "24h" | "7d" | "30d";

interface EndpointRiskTrend {
  window: RiskWindow;
  score: number;
}

const READ_ONLY_MESSAGE = "Public demo is read-only. Add a JWT token on the home page to enable write actions.";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getEndpointRiskScore(insights: OrgAiInsights | null, endpointId: string): number {
  if (!insights) {
    return 0;
  }

  return insights.topAtRiskEndpoints.find((risk) => risk.endpointId === endpointId)?.riskScore ?? 0;
}

function getEndpointAnomalies(insights: OrgAiInsights | null, endpointId: string): OrgAiEndpointAnomaly[] {
  if (!insights) {
    return [];
  }

  return insights.anomalies.filter((anomaly) => anomaly.endpointId === endpointId);
}

function getProjectedRiskDelta(baseScore: number, metrics: EndpointMetrics | null, anomalyCount: number): number {
  if (!metrics) {
    return 0;
  }

  let delta = 0;

  if (metrics.burnRate >= 4) {
    delta += 20;
  } else if (metrics.burnRate >= 2) {
    delta += 10;
  }

  if (metrics.failureRateThresholdBreached) {
    delta += 8;
  }

  if (metrics.latencyThresholdBreached) {
    delta += 6;
  }

  if (anomalyCount >= 3) {
    delta += 8;
  } else if (anomalyCount >= 1) {
    delta += 4;
  }

  if (metrics.failureRatePct < 1 && metrics.burnRate < 1) {
    delta -= 10;
  }

  const bounded = clamp(delta, -30, 30);
  const remainingHeadroom = 100 - baseScore;
  if (bounded > 0) {
    return Math.round(Math.min(bounded, remainingHeadroom));
  }

  return Math.round(Math.max(bounded, -baseScore));
}

export function EndpointDetail({ endpointId }: EndpointDetailProps) {
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [metrics, setMetrics] = useState<EndpointMetrics | null>(null);
  const [slaReport, setSlaReport] = useState<EndpointSlaReport | null>(null);
  const [aiInsights24h, setAiInsights24h] = useState<OrgAiInsights | null>(null);
  const [riskTrend, setRiskTrend] = useState<EndpointRiskTrend[]>([]);
  const [incidentTimeline, setIncidentTimeline] = useState<IncidentTimeline | null>(null);
  const [checks, setChecks] = useState<ProbeResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [simulationMode, setSimulationMode] = useState<"FORCE_FAIL" | "FORCE_DEGRADED">("FORCE_FAIL");
  const [simulationFailureStatusCode, setSimulationFailureStatusCode] = useState("503");
  const [simulationLatencyMs, setSimulationLatencyMs] = useState("2500");
  const [simulationDurationMinutes, setSimulationDurationMinutes] = useState("15");
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const load = useCallback(async () => {
    const now = new Date();
    const from = new Date(now);
    from.setHours(now.getHours() - 24);

    try {
      setError(null);
      const [endpointResponse, metricsResponse, checksResponse, slaResponse] = await Promise.all([
        apiClient.getEndpoint(endpointId),
        apiClient.getMetrics(endpointId, "24h"),
        apiClient.getChecks(endpointId, from.toISOString(), now.toISOString()),
        apiClient.getSlaReport(endpointId, "24h")
      ]);

      const [ai24Response, ai7Response, ai30Response, incidentResponse] = await Promise.all([
        apiClient.getAiInsights(endpointResponse.orgId, "24h"),
        apiClient.getAiInsights(endpointResponse.orgId, "7d"),
        apiClient.getAiInsights(endpointResponse.orgId, "30d"),
        apiClient.listIncidents(endpointResponse.orgId)
      ]);
      const latestIncident = incidentResponse.items
        .filter((incident) => incident.endpointId === endpointId)
        .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))[0];

      setEndpoint(endpointResponse);
      setMetrics(metricsResponse);
      setChecks(checksResponse.items);
      setSlaReport(slaResponse);
      setAiInsights24h(ai24Response);
      setRiskTrend([
        { window: "24h", score: getEndpointRiskScore(ai24Response, endpointId) },
        { window: "7d", score: getEndpointRiskScore(ai7Response, endpointId) },
        { window: "30d", score: getEndpointRiskScore(ai30Response, endpointId) }
      ]);
      if (latestIncident) {
        const timeline = await apiClient.getIncidentTimeline(latestIncident.incidentId, 80);
        setIncidentTimeline(timeline);
      } else {
        setIncidentTimeline(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load endpoint details";
      setError(message);
    }
  }, [endpointId]);

  useEffect(() => {
    setIsAuthenticated(hasAuthToken());
    void load();
  }, [load]);

  const recentFailures = useMemo(() => checks.filter((check) => !check.ok).slice(0, 10), [checks]);
  const endpointAiRiskScore = useMemo(
    () => getEndpointRiskScore(aiInsights24h, endpointId),
    [aiInsights24h, endpointId]
  );
  const endpointAiReasons = useMemo(
    () => (aiInsights24h?.topAtRiskEndpoints.find((risk) => risk.endpointId === endpointId)?.reasons ?? []),
    [aiInsights24h, endpointId]
  );
  const endpointAiAnomalies = useMemo(
    () => getEndpointAnomalies(aiInsights24h, endpointId),
    [aiInsights24h, endpointId]
  );
  const projectedRiskDelta = useMemo(
    () => getProjectedRiskDelta(endpointAiRiskScore, metrics, endpointAiAnomalies.length),
    [endpointAiAnomalies.length, endpointAiRiskScore, metrics]
  );

  const applySimulation = useCallback(async () => {
    const authenticated = hasAuthToken();
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setError(READ_ONLY_MESSAGE);
      return;
    }

    try {
      setError(null);
      const durationMinutes = Number(simulationDurationMinutes);
      if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 24 * 60) {
        setError("Duration must be between 1 and 1440 minutes");
        return;
      }

      if (simulationMode === "FORCE_FAIL") {
        const failureStatusCode = Number(simulationFailureStatusCode);
        if (!Number.isFinite(failureStatusCode) || failureStatusCode < 100 || failureStatusCode > 599) {
          setError("Failure status code must be between 100 and 599");
          return;
        }
        await apiClient.setFailureSimulation(endpointId, {
          mode: "FORCE_FAIL",
          failureStatusCode: Math.round(failureStatusCode),
          durationMinutes: Math.round(durationMinutes)
        });
      } else {
        const forcedLatencyMs = Number(simulationLatencyMs);
        if (!Number.isFinite(forcedLatencyMs) || forcedLatencyMs < 1 || forcedLatencyMs > 60_000) {
          setError("Forced latency must be between 1 and 60000 ms");
          return;
        }

        await apiClient.setFailureSimulation(endpointId, {
          mode: "FORCE_DEGRADED",
          forcedLatencyMs: Math.round(forcedLatencyMs),
          durationMinutes: Math.round(durationMinutes)
        });
      }

      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to set simulation";
      setError(message);
    }
  }, [
    endpointId,
    load,
    simulationDurationMinutes,
    simulationFailureStatusCode,
    simulationLatencyMs,
    simulationMode
  ]);

  const clearSimulation = useCallback(async () => {
    const authenticated = hasAuthToken();
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setError(READ_ONLY_MESSAGE);
      return;
    }

    try {
      setError(null);
      await apiClient.clearFailureSimulation(endpointId);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear simulation";
      setError(message);
    }
  }, [endpointId, load]);

  if (error) {
    return (
      <main>
        <section className="panel">
          <h1>Endpoint Detail</h1>
          <p style={{ color: "var(--down)" }}>{error}</p>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="panel" style={{ marginBottom: 14 }}>
        <h1 style={{ marginTop: 0 }}>Endpoint Detail</h1>
        <p className="small">{endpoint?.name ?? endpointId}</p>
        <p className="small" style={{ fontFamily: "var(--font-mono)" }}>
          {endpoint?.url ?? "Loading..."}
        </p>
        {!isAuthenticated ? <p className="small">{READ_ONLY_MESSAGE}</p> : null}
        {endpoint ? <p className={`status ${endpoint.status}`}>Status: {endpoint.status}</p> : null}
      </section>

      <section className="grid cards" style={{ marginBottom: 14 }}>
        <article className="panel">
          <div className="small">Uptime (24h)</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.uptimePct ?? 0}%</div>
        </article>
        <article className="panel">
          <div className="small">p50 Latency</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.latency.p50Ms ?? 0} ms</div>
        </article>
        <article className="panel">
          <div className="small">p95 Latency</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.latency.p95Ms ?? 0} ms</div>
        </article>
        <article className="panel">
          <div className="small">Checks</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.checks ?? 0}</div>
        </article>
        <article className="panel">
          <div className="small">SLA Target</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.slaTargetPct ?? 0}%</div>
          <div className="small">{metrics?.slaMet ? "SLA met" : "SLA breached"}</div>
        </article>
        <article className="panel">
          <div className="small">Burn Rate</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.burnRate ?? 0}x</div>
          <div className="small">{metrics?.burnRateAlert ? "Burn alert active" : "Within budget"}</div>
        </article>
        <article className="panel">
          <div className="small">Achieved SLA</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>
            {slaReport?.achievedSlaPct === null || slaReport?.achievedSlaPct === undefined
              ? "N/A"
              : `${slaReport.achievedSlaPct}%`}
          </div>
          <div className="small">
            Error budget left: {slaReport?.errorBudgetRemainingMinutes ?? 0} min
          </div>
        </article>
        <article className="panel">
          <div className="small">Failure Rate</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.failureRatePct ?? 0}%</div>
          <div className="small">
            Threshold: {metrics?.failureRateThresholdPct ?? endpoint?.failureRateThresholdPct ?? 5}%
          </div>
        </article>
        <article className="panel">
          <div className="small">Latency Threshold</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>
            {metrics?.latencyThresholdMs ?? endpoint?.latencyThresholdMs ?? 2000} ms
          </div>
          <div className="small">
            {metrics?.latencyThresholdBreached ? "Breached" : "Healthy"}
          </div>
        </article>
      </section>

      <section className="panel" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Regional Health (24h)</h2>
        <div className="grid">
          {(metrics?.byRegion ?? []).map((regionStats) => (
            <article key={regionStats.region} className="panel">
              <div style={{ fontWeight: 700 }}>{regionStats.region}</div>
              <div className="small">Checks: {regionStats.checks}</div>
              <div className="small">Uptime: {regionStats.uptimePct}%</div>
              <div className="small">Avg Latency: {regionStats.avgLatencyMs} ms</div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>AI Risk Widget</h2>
        <div className="grid cards" style={{ marginBottom: 10 }}>
          <article className="panel">
            <div className="small">Current Risk (24h)</div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                color: endpointAiRiskScore >= 70 ? "var(--down)" : endpointAiRiskScore >= 40 ? "#f5b85d" : "inherit"
              }}
            >
              {endpointAiRiskScore}
            </div>
          </article>
          <article className="panel">
            <div className="small">Predicted Risk Delta</div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 700,
                color: projectedRiskDelta > 0 ? "var(--down)" : projectedRiskDelta < 0 ? "#6fd3a6" : "inherit"
              }}
            >
              {projectedRiskDelta > 0 ? "+" : ""}
              {projectedRiskDelta}
            </div>
            <div className="small">Next cycle estimate if current burn/failure profile persists</div>
          </article>
          <article className="panel">
            <div className="small">Projected Risk</div>
            <div style={{ fontSize: 30, fontWeight: 700 }}>
              {clamp(endpointAiRiskScore + projectedRiskDelta, 0, 100)}
            </div>
          </article>
        </div>

        <h3 style={{ marginBottom: 6 }}>Risk Trend</h3>
        <div className="sparkline" aria-label="Endpoint AI risk trend">
          {riskTrend.map((point) => (
            <span key={point.window} style={{ height: `${Math.max(10, point.score)}px` }} title={`${point.window}: ${point.score}`} />
          ))}
        </div>
        <div className="small" style={{ marginTop: 8 }}>
          {riskTrend.map((point) => `${point.window}: ${point.score}`).join(" | ")}
        </div>

        <h3 style={{ marginBottom: 6 }}>Risk Drivers</h3>
        {endpointAiReasons.length === 0 ? (
          <p className="small">No major drivers detected for this endpoint in the selected window.</p>
        ) : (
          <ul style={{ marginTop: 0 }}>
            {endpointAiReasons.map((reason) => (
              <li key={reason} className="small">
                {reason}
              </li>
            ))}
          </ul>
        )}

        <h3 style={{ marginBottom: 6 }}>Endpoint Anomalies</h3>
        {endpointAiAnomalies.length === 0 ? (
          <p className="small">No endpoint anomalies detected.</p>
        ) : (
          <div className="grid">
            {endpointAiAnomalies.slice(0, 4).map((anomaly) => (
              <article key={`${anomaly.type}-${anomaly.message}`} className="panel">
                <div style={{ fontWeight: 700 }}>
                  {anomaly.type} ({anomaly.severity})
                </div>
                <div className="small">{anomaly.message}</div>
                <div className="small">
                  Failure: {anomaly.failureRatePct}% | Burn: {anomaly.burnRate}x | Avg Latency: {anomaly.avgLatencyMs} ms
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Failure Simulation</h2>
        <p className="small">
          Active mode: {endpoint?.simulation?.mode ?? "NONE"}
          {endpoint?.simulation?.expiresAtIso
            ? ` (until ${new Date(endpoint.simulation.expiresAtIso).toLocaleString()})`
            : ""}
        </p>
        <div className="input-row" style={{ marginBottom: 10 }}>
          <select
            value={simulationMode}
            onChange={(event) => setSimulationMode(event.currentTarget.value as "FORCE_FAIL" | "FORCE_DEGRADED")}
            disabled={!isAuthenticated}
          >
            <option value="FORCE_FAIL">FORCE_FAIL</option>
            <option value="FORCE_DEGRADED">FORCE_DEGRADED</option>
          </select>
          {simulationMode === "FORCE_FAIL" ? (
            <input
              type="number"
              min={100}
              max={599}
              value={simulationFailureStatusCode}
              onChange={(event) => setSimulationFailureStatusCode(event.currentTarget.value)}
              placeholder="Status code"
              disabled={!isAuthenticated}
            />
          ) : null}
          {simulationMode === "FORCE_DEGRADED" ? (
            <input
              type="number"
              min={1}
              max={60000}
              value={simulationLatencyMs}
              onChange={(event) => setSimulationLatencyMs(event.currentTarget.value)}
              placeholder="Forced latency ms"
              disabled={!isAuthenticated}
            />
          ) : null}
          <input
            type="number"
            min={1}
            max={1440}
            value={simulationDurationMinutes}
            onChange={(event) => setSimulationDurationMinutes(event.currentTarget.value)}
            placeholder="Duration minutes"
            disabled={!isAuthenticated}
          />
          <button type="button" disabled={!isAuthenticated} onClick={() => void applySimulation()}>
            Apply Simulation
          </button>
          <button type="button" disabled={!isAuthenticated} onClick={() => void clearSimulation()}>
            Clear Simulation
          </button>
        </div>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Recent Failed Checks</h2>
        {recentFailures.length === 0 ? <p className="small">No failures in the selected period.</p> : null}
        <div className="grid">
          {recentFailures.map((failure) => (
            <article
              key={`${failure.timestampIso}-${failure.region}`}
              className="panel"
              style={{ background: "rgba(42, 8, 17, 0.4)" }}
            >
              <div style={{ fontWeight: 700 }}>{new Date(failure.timestampIso).toLocaleString()}</div>
              <div className="small">Region: {failure.region}</div>
              <div className="small">Error: {failure.errorType ?? "HTTP failure"}</div>
              <div className="small">Status: {failure.statusCode ?? "-"}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Incident Timeline</h2>
        {!incidentTimeline ? <p className="small">No incident timeline available yet.</p> : null}
        {incidentTimeline ? (
          <div className="grid">
            {incidentTimeline.events.map((item, index) => (
              <article key={`${item.ts}-${item.type}-${index}`} className="panel">
                <div style={{ fontWeight: 700 }}>{new Date(item.ts).toLocaleString()}</div>
                <div className="small">Type: {item.type}</div>
                <div className="small">{item.message}</div>
                {item.region ? <div className="small">Region: {item.region}</div> : null}
                {typeof item.statusCode === "number" ? (
                  <div className="small">Status: {item.statusCode}</div>
                ) : null}
                {typeof item.latencyMs === "number" ? (
                  <div className="small">Latency: {item.latencyMs} ms</div>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
