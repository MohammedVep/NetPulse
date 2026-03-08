"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  DashboardSummary,
  Endpoint,
  Incident,
  MetricsWindow,
  MonitoringRegion,
  OrgAiInsights
} from "../../../packages/shared/src/types";
import { apiClient, hasAuthToken } from "@/lib/netpulse-client";
import { config } from "@/lib/config";

interface DashboardShellProps {
  orgId: string;
}

interface StreamEvent {
  type: "health_update" | "incident_update";
  endpointId: string;
  region?: MonitoringRegion;
  status?: Endpoint["status"];
  latencyMs?: number;
  incidentId?: string;
  state?: Incident["state"];
  openedAt?: string;
  resolvedAt?: string;
}

const windows: MetricsWindow[] = ["24h", "7d", "30d"];
const availableRegions: MonitoringRegion[] = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"];
const READ_ONLY_MESSAGE = "Public demo is read-only. Add a JWT token on the home page to enable write actions.";

function isMembershipBlockedError(message: string): boolean {
  return message.toLowerCase().includes("active org member");
}

export function DashboardShell({ orgId }: DashboardShellProps) {
  const [selectedWindow, setSelectedWindow] = useState<MetricsWindow>("24h");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [aiInsights, setAiInsights] = useState<OrgAiInsights | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [membershipBlocked, setMembershipBlocked] = useState(false);
  const [isJoiningOrg, setIsJoiningOrg] = useState(false);
  const [joinNotice, setJoinNotice] = useState<string | null>(null);
  const [newEndpointName, setNewEndpointName] = useState(config.defaultEndpointName);
  const [newEndpointUrl, setNewEndpointUrl] = useState(config.defaultEndpointUrl);
  const [newEndpointSlaTarget, setNewEndpointSlaTarget] = useState("99.9");
  const [newEndpointRegions, setNewEndpointRegions] = useState<MonitoringRegion[]>(["us-east-1"]);
  const [alertEmail, setAlertEmail] = useState(config.testAlertEmail);
  const [slackWebhook, setSlackWebhook] = useState(config.testSlackWebhookUrl);
  const [genericWebhook, setGenericWebhook] = useState(config.testWebhookUrl);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const hasTestingPresets =
    Boolean(config.testAlertEmail) || Boolean(config.testSlackWebhookUrl) || Boolean(config.testWebhookUrl);
  const loadBalancerBaseUrl = config.loadBalancerUrl.trim().replace(/\/$/, "");
  const grafanaDashboardUrl = config.grafanaDashboardUrl.trim();
  const prometheusUrl = config.prometheusUrl.trim();
  const proofPackUrl = config.proofPackUrl.trim() || "/proof-pack";
  const loadBalancerLinks = loadBalancerBaseUrl
    ? {
        healthz: `${loadBalancerBaseUrl}/healthz`,
        backends: `${loadBalancerBaseUrl}/backends`,
        metrics: `${loadBalancerBaseUrl}/metrics`,
        drill: `${loadBalancerBaseUrl}/admin/failure-mode?unhealthy=true`
      }
    : null;

  const refresh = useCallback(async () => {
    try {
      setIsAuthenticated(hasAuthToken());
      setError(null);
      setMembershipBlocked(false);
      const [summaryResponse, aiInsightsResponse, endpointResponse, incidentResponse] = await Promise.all([
        apiClient.getDashboardSummary(orgId, selectedWindow),
        apiClient.getAiInsights(orgId, selectedWindow),
        apiClient.listEndpoints(orgId, undefined, 100),
        apiClient.listIncidents(orgId, "open")
      ]);

      setSummary(summaryResponse);
      setAiInsights(aiInsightsResponse);
      setEndpoints(endpointResponse.items);
      setIncidents(incidentResponse.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load dashboard";
      setError(message);
      setMembershipBlocked(isMembershipBlockedError(message));
    }
  }, [orgId, selectedWindow]);

  useEffect(() => {
    setIsAuthenticated(hasAuthToken());
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 60_000);

    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const ws = new WebSocket(config.wsUrl);

    ws.addEventListener("open", () => {
      const token = window.localStorage.getItem("netpulse_token") ?? undefined;
      ws.send(
        JSON.stringify({
          action: "subscribe",
          orgId,
          ...(token ? { token } : {})
        })
      );
    });

    ws.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data) as StreamEvent;

        if (payload.type === "health_update" && payload.status) {
          const status = payload.status;
          const latencyUpdate =
            typeof payload.latencyMs === "number" ? { lastLatencyMs: payload.latencyMs } : {};
          setEndpoints((current) =>
            current.map((endpoint) =>
              endpoint.endpointId === payload.endpointId
                ? {
                    ...endpoint,
                    status,
                    ...latencyUpdate,
                    updatedAt: new Date().toISOString()
                  }
                : endpoint
            )
          );
          return;
        }

        if (payload.type === "incident_update" && payload.incidentId && payload.state) {
          const incidentId = payload.incidentId;
          const eventRegion = payload.region ?? "us-east-1";
          setIncidents((current) => {
            const withoutEndpoint = current.filter((incident) => {
              const incidentRegion = incident.region ?? "us-east-1";
              return !(incident.endpointId === payload.endpointId && incidentRegion === eventRegion);
            });
            if (payload.state === "OPEN") {
              return [
                {
                  incidentId,
                  orgId,
                  endpointId: payload.endpointId,
                  region: eventRegion,
                  state: "OPEN",
                  openedAt: payload.openedAt ?? new Date().toISOString(),
                  failureCount: 2
                },
                ...withoutEndpoint
              ];
            }
            return withoutEndpoint;
          });
        }
      } catch {
        // ignore malformed event messages
      }
    });

    return () => {
      ws.close();
    };
  }, [isAuthenticated, orgId]);

  const totals = useMemo(() => {
    return {
      total: endpoints.filter((endpoint) => endpoint.status !== "DELETED").length,
      down: endpoints.filter((endpoint) => endpoint.status === "DOWN").length,
      paused: endpoints.filter((endpoint) => endpoint.status === "PAUSED").length
    };
  }, [endpoints]);

  const createEndpoint = useCallback(async () => {
    const authenticated = hasAuthToken();
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setError(READ_ONLY_MESSAGE);
      return;
    }

    if (!newEndpointName.trim() || !newEndpointUrl.trim()) {
      return;
    }
    const slaTarget = Number(newEndpointSlaTarget);
    if (!Number.isFinite(slaTarget) || slaTarget < 90 || slaTarget > 100) {
      setError("SLA target must be between 90 and 100");
      return;
    }

    try {
      setError(null);
      await apiClient.createEndpoint({
        orgId,
        name: newEndpointName.trim(),
        url: newEndpointUrl.trim(),
        timeoutMs: 6000,
        tags: [],
        checkRegions: newEndpointRegions,
        slaTargetPct: slaTarget
      });
      setNewEndpointName("");
      setNewEndpointUrl("");
      setNewEndpointSlaTarget("99.9");
      setNewEndpointRegions(["us-east-1"]);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create endpoint";
      setError(message);
    }
  }, [newEndpointName, newEndpointRegions, newEndpointSlaTarget, newEndpointUrl, orgId, refresh]);

  const togglePause = useCallback(
    async (endpoint: Endpoint) => {
      const authenticated = hasAuthToken();
      setIsAuthenticated(authenticated);
      if (!authenticated) {
        setError(READ_ONLY_MESSAGE);
        return;
      }

      try {
        setError(null);
        await apiClient.patchEndpoint(endpoint.endpointId, { paused: !endpoint.paused });
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update endpoint";
        setError(message);
      }
    },
    [refresh]
  );

  const deleteEndpoint = useCallback(
    async (endpointId: string) => {
      const authenticated = hasAuthToken();
      setIsAuthenticated(authenticated);
      if (!authenticated) {
        setError(READ_ONLY_MESSAGE);
        return;
      }

      try {
        setError(null);
        await apiClient.deleteEndpoint(endpointId);
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete endpoint";
        setError(message);
      }
    },
    [refresh]
  );

  const toggleRegionSelection = useCallback((region: MonitoringRegion) => {
    setNewEndpointRegions((current) => {
      if (current.includes(region)) {
        if (current.length === 1) {
          return current;
        }
        return current.filter((item) => item !== region);
      }
      return [...current, region];
    });
  }, []);

  const loadTestingPresets = useCallback(() => {
    setNewEndpointName(config.defaultEndpointName);
    setNewEndpointUrl(config.defaultEndpointUrl);
    setAlertEmail(config.testAlertEmail);
    setSlackWebhook(config.testSlackWebhookUrl);
    setGenericWebhook(config.testWebhookUrl);
  }, []);

  const joinOrganization = useCallback(async () => {
    const authenticated = hasAuthToken();
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setError("Sign in first to join this organization");
      return;
    }

    try {
      setIsJoiningOrg(true);
      setError(null);
      setJoinNotice(null);
      await apiClient.joinOrganization(orgId);
      setJoinNotice("Joined organization as Viewer. Reloading dashboard...");
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to join organization";
      setError(message);
    } finally {
      setIsJoiningOrg(false);
    }
  }, [orgId, refresh]);

  const registerEmailAlert = useCallback(async () => {
    const authenticated = hasAuthToken();
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setError(READ_ONLY_MESSAGE);
      return;
    }

    if (!alertEmail.trim()) return;

    try {
      setError(null);
      await apiClient.registerEmailChannel(orgId, alertEmail.trim());
      setAlertEmail("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to register email alert";
      setError(message);
    }
  }, [alertEmail, orgId]);

  const registerSlackAlert = useCallback(async () => {
    const authenticated = hasAuthToken();
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setError(READ_ONLY_MESSAGE);
      return;
    }

    if (!slackWebhook.trim()) return;

    try {
      setError(null);
      await apiClient.registerSlackChannel(orgId, slackWebhook.trim());
      setSlackWebhook("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to register Slack alert";
      setError(message);
    }
  }, [orgId, slackWebhook]);

  const registerWebhookAlert = useCallback(async () => {
    const authenticated = hasAuthToken();
    setIsAuthenticated(authenticated);
    if (!authenticated) {
      setError(READ_ONLY_MESSAGE);
      return;
    }

    if (!genericWebhook.trim()) return;

    try {
      setError(null);
      await apiClient.registerWebhookChannel(orgId, {
        name: "Generic Webhook",
        url: genericWebhook.trim(),
        events: [
          "INCIDENT_OPEN",
          "INCIDENT_RESOLVED",
          "SLO_BURN_RATE",
          "LATENCY_BREACH",
          "FAILURE_RATE_BREACH"
        ]
      });
      setGenericWebhook("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to register webhook alert";
      setError(message);
    }
  }, [genericWebhook, orgId]);

  return (
    <main>
      <section className="panel soft stack" style={{ marginBottom: 14 }}>
        <div className="control-row">
          <span className="pill">Reliability Control Plane</span>
          <p className="small" style={{ margin: 0 }}>
            Organization <code>{orgId}</code>
          </p>
        </div>
        <h1 className="hero-title" style={{ margin: 0, fontSize: "clamp(1.8rem, 5vw, 3rem)" }}>
          NetPulse Operations Dashboard
        </h1>
        <p className="small" style={{ marginTop: 0, maxWidth: 900 }}>
          Live status for multi-region health checks, service-discovered load balancer routing, circuit-breaker
          behavior, and SaaS reliability controls hardened by PgBouncer + mTLS.
        </p>
        {!isAuthenticated ? (
          <p className="small" style={{ margin: 0 }}>
            {READ_ONLY_MESSAGE}
          </p>
        ) : null}
        <div className="control-row">
          <label className="small" htmlFor="window">
            Window
          </label>
          <select
            id="window"
            value={selectedWindow}
            onChange={(event) => setSelectedWindow(event.currentTarget.value as MetricsWindow)}
          >
            {windows.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {error ? <p style={{ color: "var(--down)", margin: 0 }}>{error}</p> : null}
      </section>

      {membershipBlocked && isAuthenticated ? (
        <section className="panel soft stack" style={{ marginBottom: 14 }}>
          <h2 className="section-head">Access Required</h2>
          <p className="small" style={{ margin: 0 }}>
            You are authenticated but not an active member of <code>{orgId}</code>.
          </p>
          <div className="control-row">
            <button type="button" disabled={isJoiningOrg} onClick={() => void joinOrganization()}>
              {isJoiningOrg ? "Joining..." : "Join This Org as Viewer"}
            </button>
          </div>
          {joinNotice ? (
            <p className="small" style={{ margin: 0, color: "var(--ok)" }}>
              {joinNotice}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="kpi-grid" style={{ marginBottom: 14 }}>
        <article className="kpi-card">
          <div className="kpi-label">Uptime ({selectedWindow})</div>
          <div className="kpi-value">{summary?.uptimePct ?? 0}%</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Failure Rate ({selectedWindow})</div>
          <div className="kpi-value">{summary?.failureRatePct ?? 0}%</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Burn Rate</div>
          <div className="kpi-value" style={{ color: summary?.burnRateAlert ? "var(--down)" : "inherit" }}>
            {summary?.burnRate ?? 0}x
          </div>
          <div className="small">{summary?.burnRateAlert ? "Budget burn alert" : "Within SLO budget"}</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Endpoints</div>
          <div className="kpi-value">{totals.total}</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Down</div>
          <div className="kpi-value" style={{ color: "var(--down)" }}>
            {totals.down}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Paused</div>
          <div className="kpi-value" style={{ color: "var(--warn)" }}>
            {totals.paused}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Open Incidents</div>
          <div className="kpi-value">{incidents.length}</div>
        </article>
      </section>

      <section className="split-grid" style={{ marginBottom: 14 }}>
        <article className="panel stack">
          <h2 className="section-head">Load Balancer Runtime</h2>
          {loadBalancerLinks ? (
            <>
              <p className="small" style={{ margin: 0 }}>
                Service discovery + circuit breaker URLs from this deployed stack.
              </p>
              <p className="small" style={{ margin: 0 }}>
                Base URL: <code>{loadBalancerBaseUrl}</code>
              </p>
              <div className="control-row">
                <a href={loadBalancerLinks.healthz} target="_blank" rel="noreferrer">
                  <code>/healthz</code>
                </a>
                <a href={loadBalancerLinks.backends} target="_blank" rel="noreferrer">
                  <code>/backends</code>
                </a>
                <a href={loadBalancerLinks.metrics} target="_blank" rel="noreferrer">
                  <code>/metrics</code>
                </a>
              </div>
              <div className="command mono">curl {loadBalancerLinks.drill}</div>
              {grafanaDashboardUrl ? (
                <p className="small" style={{ margin: 0 }}>
                  Grafana:{" "}
                  <a href={grafanaDashboardUrl} target="_blank" rel="noreferrer">
                    <code>{grafanaDashboardUrl}</code>
                  </a>
                </p>
              ) : null}
              {prometheusUrl ? (
                <p className="small" style={{ margin: 0 }}>
                  Prometheus:{" "}
                  <a href={prometheusUrl} target="_blank" rel="noreferrer">
                    <code>{prometheusUrl}</code>
                  </a>
                </p>
              ) : null}
              <p className="small" style={{ margin: 0 }}>
                Proof Pack:{" "}
                <a href={proofPackUrl} target="_blank" rel="noreferrer">
                  <code>{proofPackUrl}</code>
                </a>
              </p>
            </>
          ) : (
            <p className="small" style={{ margin: 0 }}>
              Configure <code>NEXT_PUBLIC_LOAD_BALANCER_URL</code> to render runtime service-discovery and
              circuit-breaker drill links in this view.
            </p>
          )}
        </article>

        <article className="panel stack">
          <h2 className="section-head">Architecture Upgrade Signals</h2>
          <ul className="list-tight">
            <li className="small">Dynamic backend registration updates routing tables without load balancer restarts.</li>
            <li className="small">Active health probes trip failing nodes out of rotation and reintroduce on recovery.</li>
            <li className="small">Prometheus metrics and Grafana panels expose latency, connection load, and 5xx rates.</li>
            <li className="small">PgBouncer protects PostgreSQL against connection exhaustion under concurrency spikes.</li>
            <li className="small">mTLS secures regional worker traffic to central queue endpoints under zero-trust policy.</li>
          </ul>
        </article>
      </section>

      <section className="split-grid" style={{ marginBottom: 14 }}>
        <article className="panel stack">
          <h2 className="section-head">Uptime Trend</h2>
          <div className="sparkline" aria-label="Uptime sparkline">
            {(summary?.sparkline ?? []).map((point: { t: string; uptimePct: number }) => (
              <span key={point.t} style={{ height: `${Math.max(8, point.uptimePct * 0.75)}px` }} />
            ))}
          </div>
        </article>
        <article className="panel stack">
          <h2 className="section-head">Burn Rate Trend</h2>
          <div className="sparkline" aria-label="Burn rate sparkline">
            {(summary?.burnRateSparkline ?? []).map((point: { t: string; burnRate: number }) => (
              <span key={point.t} style={{ height: `${Math.max(8, Math.min(100, point.burnRate * 15))}px` }} />
            ))}
          </div>
        </article>
      </section>

      <section className="panel stack" style={{ marginBottom: 14 }}>
        <h2 className="section-head">AI Insights</h2>
        <div className="kpi-grid">
          <article className="kpi-card">
            <div className="kpi-label">Risk Level</div>
            <div
              className="kpi-value"
              style={{
                color:
                  aiInsights?.riskLevel === "CRITICAL" || aiInsights?.riskLevel === "HIGH"
                    ? "var(--down)"
                    : "inherit"
              }}
            >
              {aiInsights?.riskLevel ?? "-"}
            </div>
          </article>
          <article className="kpi-card">
            <div className="kpi-label">AI Failure Rate</div>
            <div className="kpi-value">{aiInsights?.totals.failureRatePct ?? 0}%</div>
          </article>
          <article className="kpi-card">
            <div className="kpi-label">AI Avg Burn Rate</div>
            <div className="kpi-value">{aiInsights?.totals.avgBurnRate ?? 0}x</div>
          </article>
          <article className="kpi-card">
            <div className="kpi-label">Anomalies</div>
            <div className="kpi-value">{aiInsights?.anomalies.length ?? 0}</div>
          </article>
        </div>

        <p className="small" style={{ margin: 0 }}>
          {aiInsights?.summary ?? "No AI summary available yet."}
        </p>
        <p className="small" style={{ margin: 0 }}>
          Model: <code>{aiInsights?.model ?? "n/a"}</code> | Generated:{" "}
          {aiInsights?.generatedAt ? new Date(aiInsights.generatedAt).toLocaleString() : "-"}
        </p>

        <h3 className="section-head">Top At-Risk Endpoints</h3>
        {aiInsights?.topAtRiskEndpoints.length ? (
          <div className="grid">
            {aiInsights.topAtRiskEndpoints.map((risk) => (
              <article key={risk.endpointId} className="signal-card">
                <div style={{ fontWeight: 700 }}>{risk.endpointName}</div>
                <div className="small mono">{risk.endpointId}</div>
                <div style={{ marginTop: 6 }}>Risk Score: {risk.riskScore}</div>
                <div className="small">{risk.reasons.join(" | ") || "No specific drivers"}</div>
              </article>
            ))}
          </div>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            No elevated endpoint risk detected.
          </p>
        )}

        <h3 className="section-head">Recommendations</h3>
        {aiInsights?.recommendations.length ? (
          <ul className="list-tight">
            {aiInsights.recommendations.map((recommendation) => (
              <li key={recommendation} className="small">
                {recommendation}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            No recommendations yet.
          </p>
        )}
      </section>

      <section className="split-grid" style={{ marginBottom: 14 }}>
        <article className="panel stack">
          <h2 className="section-head">Endpoints</h2>
          {config.showTestingHints ? (
            <p className="small" style={{ margin: 0 }}>
              Recruiter mode is enabled. Endpoint defaults are preloaded from environment configuration.
            </p>
          ) : null}
          <div className="input-row">
            <input
              type="text"
              placeholder="Endpoint name"
              value={newEndpointName}
              onChange={(event) => setNewEndpointName(event.currentTarget.value)}
            />
            <input
              type="text"
              placeholder="https://api.example.com/health"
              value={newEndpointUrl}
              onChange={(event) => setNewEndpointUrl(event.currentTarget.value)}
              style={{ minWidth: 260 }}
            />
            <input
              type="number"
              min={90}
              max={100}
              step={0.01}
              placeholder="SLA target %"
              value={newEndpointSlaTarget}
              onChange={(event) => setNewEndpointSlaTarget(event.currentTarget.value)}
              style={{ width: 130 }}
            />
            <button type="button" disabled={!isAuthenticated} onClick={() => void createEndpoint()}>
              Add Endpoint
            </button>
            {(config.showTestingHints || hasTestingPresets) && isAuthenticated ? (
              <button type="button" onClick={loadTestingPresets}>
                Load Test Presets
              </button>
            ) : null}
          </div>
          <div className="input-row">
            <span className="small">Check regions:</span>
            {availableRegions.map((region) => (
              <label key={region} className="small" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={newEndpointRegions.includes(region)}
                  onChange={() => toggleRegionSelection(region)}
                />
                {region}
              </label>
            ))}
          </div>

          <div className="grid">
            {endpoints.map((endpoint) => (
              <article
                key={endpoint.endpointId}
                className="signal-card"
                style={{
                  background: "rgba(8, 16, 32, 0.75)",
                  border: "1px solid rgba(103, 211, 255, 0.2)"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <Link
                      href={`/org/${encodeURIComponent(orgId)}/endpoints/${encodeURIComponent(endpoint.endpointId)}`}
                      style={{ fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 4 }}
                    >
                      {endpoint.name}
                    </Link>
                    <div className="small mono">{endpoint.url}</div>
                  </div>
                  <span className={`status ${endpoint.status}`}>{endpoint.status}</span>
                </div>
                <div className="small" style={{ marginTop: 8 }}>
                  Last latency: {endpoint.lastLatencyMs ?? "-"} ms
                </div>
                <div className="small">Regions: {(endpoint.checkRegions ?? ["us-east-1"]).join(", ")}</div>
                <div className="small">SLA target: {endpoint.slaTargetPct ?? 99.9}%</div>
                <div className="input-row" style={{ marginTop: 10 }}>
                  <button type="button" disabled={!isAuthenticated} onClick={() => void togglePause(endpoint)}>
                    {endpoint.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    disabled={!isAuthenticated}
                    onClick={() => void deleteEndpoint(endpoint.endpointId)}
                    style={{ background: "linear-gradient(135deg, #8f2f46, #d2555f)" }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </article>

        <article className="panel stack">
          <h2 className="section-head">Open Incidents</h2>
          {incidents.length === 0 ? <p className="small">No open incidents.</p> : null}
          <div className="grid">
            {incidents.map((incident) => (
              <article key={incident.incidentId} className="signal-card" style={{ background: "rgba(42, 8, 17, 0.4)" }}>
                <div style={{ fontWeight: 700 }}>{incident.endpointId}</div>
                <div className="small">Region: {incident.region ?? "us-east-1"}</div>
                <div className="small">Opened: {new Date(incident.openedAt).toLocaleString()}</div>
                <div className="small">State: {incident.state}</div>
              </article>
            ))}
          </div>
        </article>
      </section>

      <section className="panel stack">
        <h2 className="section-head">Alert Channels</h2>
        {hasTestingPresets ? (
          <p className="small" style={{ margin: 0 }}>
            Prefilled test values are loaded from frontend env vars for recruiter demo drills.
          </p>
        ) : null}
        <div className="grid">
          <div className="input-row">
            <input
              type="email"
              placeholder="team-oncall@example.com"
              value={alertEmail}
              onChange={(event) => setAlertEmail(event.currentTarget.value)}
              style={{ minWidth: 280 }}
            />
            <button type="button" disabled={!isAuthenticated} onClick={() => void registerEmailAlert()}>
              Add Email Channel
            </button>
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="https://hooks.slack.com/services/..."
              value={slackWebhook}
              onChange={(event) => setSlackWebhook(event.currentTarget.value)}
              style={{ minWidth: 360 }}
            />
            <button type="button" disabled={!isAuthenticated} onClick={() => void registerSlackAlert()}>
              Add Slack Channel
            </button>
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="https://alerts.example.com/netpulse"
              value={genericWebhook}
              onChange={(event) => setGenericWebhook(event.currentTarget.value)}
              style={{ minWidth: 360 }}
            />
            <button type="button" disabled={!isAuthenticated} onClick={() => void registerWebhookAlert()}>
              Add Webhook Channel
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
