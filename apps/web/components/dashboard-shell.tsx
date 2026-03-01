"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  DashboardSummary,
  Endpoint,
  Incident,
  MetricsWindow,
  MonitoringRegion
} from "@netpulse/shared";
import { apiClient } from "@/lib/netpulse-client";
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

export function DashboardShell({ orgId }: DashboardShellProps) {
  const [selectedWindow, setSelectedWindow] = useState<MetricsWindow>("24h");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newEndpointName, setNewEndpointName] = useState("");
  const [newEndpointUrl, setNewEndpointUrl] = useState("");
  const [newEndpointSlaTarget, setNewEndpointSlaTarget] = useState("99.9");
  const [newEndpointRegions, setNewEndpointRegions] = useState<MonitoringRegion[]>(["us-east-1"]);
  const [alertEmail, setAlertEmail] = useState("");
  const [slackWebhook, setSlackWebhook] = useState("");
  const [genericWebhook, setGenericWebhook] = useState("");

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [summaryResponse, endpointResponse, incidentResponse] = await Promise.all([
        apiClient.getDashboardSummary(orgId, selectedWindow),
        apiClient.listEndpoints(orgId, undefined, 100),
        apiClient.listIncidents(orgId, "open")
      ]);

      setSummary(summaryResponse);
      setEndpoints(endpointResponse.items);
      setIncidents(incidentResponse.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load dashboard";
      setError(message);
    }
  }, [orgId, selectedWindow]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 60_000);

    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
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
  }, [orgId]);

  const totals = useMemo(() => {
    return {
      total: endpoints.filter((endpoint) => endpoint.status !== "DELETED").length,
      down: endpoints.filter((endpoint) => endpoint.status === "DOWN").length,
      paused: endpoints.filter((endpoint) => endpoint.status === "PAUSED").length
    };
  }, [endpoints]);

  const createEndpoint = useCallback(async () => {
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

  const registerEmailAlert = useCallback(async () => {
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
    if (!genericWebhook.trim()) return;

    try {
      setError(null);
      await apiClient.registerWebhookChannel(orgId, genericWebhook.trim());
      setGenericWebhook("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to register webhook alert";
      setError(message);
    }
  }, [genericWebhook, orgId]);

  return (
    <main>
      <section className="panel" style={{ marginBottom: 14 }}>
        <h1 style={{ marginTop: 0 }}>NetPulse Dashboard</h1>
        <p className="small" style={{ marginTop: 4 }}>
          Organization <code>{orgId}</code>
        </p>
        <div className="input-row" style={{ marginTop: 12 }}>
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
        {error ? <p style={{ color: "#ff6c7a" }}>{error}</p> : null}
      </section>

      <section className="grid cards" style={{ marginBottom: 14 }}>
        <article className="panel">
          <div className="small">Uptime ({selectedWindow})</div>
          <div style={{ fontSize: 34, fontWeight: 700 }}>{summary?.uptimePct ?? 0}%</div>
        </article>
        <article className="panel">
          <div className="small">Endpoints</div>
          <div style={{ fontSize: 34, fontWeight: 700 }}>{totals.total}</div>
        </article>
        <article className="panel">
          <div className="small">Down</div>
          <div style={{ fontSize: 34, fontWeight: 700, color: "var(--down)" }}>{totals.down}</div>
        </article>
        <article className="panel">
          <div className="small">Open Incidents</div>
          <div style={{ fontSize: 34, fontWeight: 700 }}>{incidents.length}</div>
        </article>
      </section>

      <section className="panel" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Uptime Trend</h2>
        <div className="sparkline" aria-label="Uptime sparkline">
          {(summary?.sparkline ?? []).map((point: { t: string; uptimePct: number }) => (
            <span key={point.t} style={{ height: `${Math.max(8, point.uptimePct * 0.75)}px` }} />
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Endpoints</h2>
        <div className="input-row" style={{ marginBottom: 12 }}>
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
            style={{ minWidth: 280 }}
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
          <button type="button" onClick={() => void createEndpoint()}>
            Add Endpoint
          </button>
        </div>
        <div className="input-row" style={{ marginBottom: 12 }}>
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
              className="panel"
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
                  <div className="small" style={{ fontFamily: "var(--font-mono)" }}>
                    {endpoint.url}
                  </div>
                </div>
                <span className={`status ${endpoint.status}`}>{endpoint.status}</span>
              </div>
              <div className="small" style={{ marginTop: 8 }}>
                Last latency: {endpoint.lastLatencyMs ?? "-"} ms
              </div>
              <div className="small">
                Regions: {(endpoint.checkRegions ?? ["us-east-1"]).join(", ")}
              </div>
              <div className="small">SLA target: {endpoint.slaTargetPct ?? 99.9}%</div>
              <div className="input-row" style={{ marginTop: 10 }}>
                <button type="button" onClick={() => void togglePause(endpoint)}>
                  {endpoint.paused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteEndpoint(endpoint.endpointId)}
                  style={{ background: "linear-gradient(135deg, #8f2f46, #d2555f)" }}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Open Incidents</h2>
        {incidents.length === 0 ? <p className="small">No open incidents.</p> : null}
        <div className="grid">
          {incidents.map((incident) => (
            <article key={incident.incidentId} className="panel" style={{ background: "rgba(42, 8, 17, 0.4)" }}>
              <div style={{ fontWeight: 700 }}>{incident.endpointId}</div>
              <div className="small">Region: {incident.region ?? "us-east-1"}</div>
              <div className="small">Opened: {new Date(incident.openedAt).toLocaleString()}</div>
              <div className="small">State: {incident.state}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Alert Channels</h2>
        <div className="grid">
          <div className="input-row">
            <input
              type="email"
              placeholder="team-oncall@example.com"
              value={alertEmail}
              onChange={(event) => setAlertEmail(event.currentTarget.value)}
              style={{ minWidth: 280 }}
            />
            <button type="button" onClick={() => void registerEmailAlert()}>
              Add Email Channel
            </button>
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="https://hooks.slack.com/services/..."
              value={slackWebhook}
              onChange={(event) => setSlackWebhook(event.currentTarget.value)}
              style={{ minWidth: 380 }}
            />
            <button type="button" onClick={() => void registerSlackAlert()}>
              Add Slack Channel
            </button>
          </div>
          <div className="input-row">
            <input
              type="text"
              placeholder="https://alerts.example.com/netpulse"
              value={genericWebhook}
              onChange={(event) => setGenericWebhook(event.currentTarget.value)}
              style={{ minWidth: 380 }}
            />
            <button type="button" onClick={() => void registerWebhookAlert()}>
              Add Webhook Channel
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
