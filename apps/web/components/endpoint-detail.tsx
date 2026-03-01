"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Endpoint,
  EndpointMetrics,
  EndpointSlaReport,
  ProbeResult
} from "../../../packages/shared/src/types";
import { apiClient } from "@/lib/netpulse-client";

interface EndpointDetailProps {
  endpointId: string;
}

type MutableSimulationMode = "FORCE_FAIL" | "FLAKY" | "LATENCY_SPIKE";

export function EndpointDetail({ endpointId }: EndpointDetailProps) {
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [metrics, setMetrics] = useState<EndpointMetrics | null>(null);
  const [slaReport, setSlaReport] = useState<EndpointSlaReport | null>(null);
  const [checks, setChecks] = useState<ProbeResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [simulationMode, setSimulationMode] = useState<MutableSimulationMode>("FORCE_FAIL");
  const [simulationFailureRate, setSimulationFailureRate] = useState("50");
  const [simulationLatencyMs, setSimulationLatencyMs] = useState("5000");
  const [simulationUntil, setSimulationUntil] = useState("");

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
      setEndpoint(endpointResponse);
      setMetrics(metricsResponse);
      setChecks(checksResponse.items);
      setSlaReport(slaResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load endpoint details";
      setError(message);
    }
  }, [endpointId]);

  useEffect(() => {
    void load();
  }, [load]);

  const recentFailures = useMemo(() => checks.filter((check) => !check.ok).slice(0, 10), [checks]);

  const applySimulation = useCallback(async () => {
    try {
      setError(null);
      const payload: {
        mode: "FORCE_FAIL" | "FLAKY" | "LATENCY_SPIKE";
        failureRatePct?: number;
        extraLatencyMs?: number;
        until?: string;
      } = { mode: simulationMode };

      if (simulationMode === "FLAKY") {
        const failureRatePct = Number(simulationFailureRate);
        if (!Number.isFinite(failureRatePct) || failureRatePct < 1 || failureRatePct > 100) {
          setError("Flaky failure rate must be between 1 and 100");
          return;
        }
        payload.failureRatePct = Math.round(failureRatePct);
      }

      if (simulationMode === "LATENCY_SPIKE") {
        const extraLatencyMs = Number(simulationLatencyMs);
        if (!Number.isFinite(extraLatencyMs) || extraLatencyMs < 1 || extraLatencyMs > 60_000) {
          setError("Latency spike must be between 1 and 60000 ms");
          return;
        }
        payload.extraLatencyMs = Math.round(extraLatencyMs);
      }

      if (simulationUntil.trim()) {
        const until = new Date(simulationUntil);
        if (Number.isNaN(until.getTime())) {
          setError("Simulation end time is invalid");
          return;
        }
        payload.until = until.toISOString();
      }

      const updatedEndpoint = await apiClient.setFailureSimulation(endpointId, payload);
      setEndpoint(updatedEndpoint);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to set simulation";
      setError(message);
    }
  }, [endpointId, load, simulationFailureRate, simulationLatencyMs, simulationMode, simulationUntil]);

  const clearSimulation = useCallback(async () => {
    try {
      setError(null);
      const updatedEndpoint = await apiClient.clearFailureSimulation(endpointId);
      setEndpoint(updatedEndpoint);
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
          <div className="small">Error Budget Left</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{metrics?.errorBudgetRemainingPct ?? 0}%</div>
          <div className="small">
            Remaining downtime: {slaReport?.remainingDowntimeMinutes ?? 0} min
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
        <h2 style={{ marginTop: 0 }}>Failure Simulation</h2>
        <p className="small">
          Active mode: {endpoint?.simulation?.mode ?? "NONE"}
          {endpoint?.simulation?.until ? ` (until ${new Date(endpoint.simulation.until).toLocaleString()})` : ""}
        </p>
        <div className="input-row" style={{ marginBottom: 10 }}>
          <select
            value={simulationMode}
            onChange={(event) => setSimulationMode(event.currentTarget.value as MutableSimulationMode)}
          >
            <option value="FORCE_FAIL">FORCE_FAIL</option>
            <option value="FLAKY">FLAKY</option>
            <option value="LATENCY_SPIKE">LATENCY_SPIKE</option>
          </select>
          {simulationMode === "FLAKY" ? (
            <input
              type="number"
              min={1}
              max={100}
              value={simulationFailureRate}
              onChange={(event) => setSimulationFailureRate(event.currentTarget.value)}
              placeholder="Failure rate %"
            />
          ) : null}
          {simulationMode === "LATENCY_SPIKE" ? (
            <input
              type="number"
              min={1}
              max={60000}
              value={simulationLatencyMs}
              onChange={(event) => setSimulationLatencyMs(event.currentTarget.value)}
              placeholder="Extra latency ms"
            />
          ) : null}
          <input
            type="datetime-local"
            value={simulationUntil}
            onChange={(event) => setSimulationUntil(event.currentTarget.value)}
          />
          <button type="button" onClick={() => void applySimulation()}>
            Apply Simulation
          </button>
          <button type="button" onClick={() => void clearSimulation()}>
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
    </main>
  );
}
