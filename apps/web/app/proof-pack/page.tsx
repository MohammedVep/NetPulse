import Link from "next/link";

const proofPack = {
  runId: "proofpack-20260308T184847Z",
  windowUtc: "2026-03-08T18:48:47Z to 2026-03-08T18:49:36Z",
  killAtIso: "2026-03-08T18:49:31.938Z",
  killCommand: "chaos-injector kill regional-worker-1 regional-worker-2",
  detectionLatencyMs: 5,
  expectedMessages: 10_000,
  processedMessages: 10_000,
  dataLoss: 0,
  dlqQueued: 3_684,
  dlqReplayed: 3_684,
  writesCompleted: 10_000,
  writesFailed: 0,
  writesPerSecond: 5_564.83,
  pgTotalConnections: 17,
  pgActiveConnections: 1
};

const commands = [
  "docker compose -f infra/high-concurrency/docker-compose.yml up -d",
  "TOTAL_WRITES=10000 WRITE_CONCURRENCY=1000 POOL_MAX_CONNECTIONS=1200 npm run drill:pgbouncer",
  "MTLS_WORKERS=4 MTLS_EVENTS_PER_WORKER=2500 MTLS_EVENT_INTERVAL_MS=2 MTLS_KILL_RATIO=0.5 MTLS_KILL_AFTER_MS=1500 npm run drill:mtls:chaos"
];

export default function ProofPackPage() {
  return (
    <main>
      <section className="panel soft stack" style={{ marginTop: 26 }}>
        <div className="control-row">
          <span className="pill">Reliability Evidence</span>
          <p className="small" style={{ margin: 0 }}>
            Run <code>{proofPack.runId}</code>
          </p>
        </div>
        <h1 className="hero-title" style={{ margin: 0 }}>
          NetPulse Proof Pack
        </h1>
        <p className="small" style={{ marginTop: 0 }}>
          Execution window (UTC): <code>{proofPack.windowUtc}</code>
        </p>
        <p className="small" style={{ margin: 0 }}>
          Hypothesis: if 50% of regional workers fail during a 10k-event burst, NetPulse should detect quickly, replay
          queued events, and keep total data loss at zero.
        </p>
      </section>

      <section className="panel stack" style={{ marginTop: 14 }}>
        <h2 className="section-head">Commands</h2>
        {commands.map((command) => (
          <div key={command} className="command mono">
            {command}
          </div>
        ))}
        <div className="command mono">{proofPack.killCommand}</div>
      </section>

      <section className="kpi-grid" style={{ marginTop: 14 }}>
        <article className="kpi-card">
          <div className="kpi-label">Worker Kill Timestamp</div>
          <div className="kpi-value" style={{ fontSize: "1.2rem" }}>
            {proofPack.killAtIso}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Detection Latency</div>
          <div className="kpi-value">{proofPack.detectionLatencyMs}ms</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Data Loss</div>
          <div className="kpi-value" style={{ color: proofPack.dataLoss === 0 ? "var(--ok)" : "var(--down)" }}>
            {proofPack.dataLoss}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Processed / Expected</div>
          <div className="kpi-value">
            {proofPack.processedMessages}/{proofPack.expectedMessages}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">DLQ Replay</div>
          <div className="kpi-value">
            {proofPack.dlqReplayed}/{proofPack.dlqQueued}
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">PgBouncer Spike</div>
          <div className="kpi-value" style={{ fontSize: "1.2rem" }}>
            {proofPack.writesCompleted} writes
          </div>
          <div className="small">
            failed {proofPack.writesFailed} | {proofPack.writesPerSecond}/sec
          </div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Postgres Connections</div>
          <div className="kpi-value" style={{ fontSize: "1.2rem" }}>
            {proofPack.pgActiveConnections}/{proofPack.pgTotalConnections} active/total
          </div>
        </article>
      </section>

      <section className="panel stack" style={{ marginTop: 14 }}>
        <h2 className="section-head">Grafana Evidence Points</h2>
        <ul className="list-tight">
          <li className="small">Worker health drops from 4 to 2 at kill timestamp.</li>
          <li className="small">Security/error signal spikes on mTLS handshake rejection.</li>
          <li className="small">Processed jobs curve continues climbing after the outage.</li>
          <li className="small">DLQ queued and replayed converge to equal counts.</li>
        </ul>
      </section>

      <section className="panel stack" style={{ marginTop: 14 }}>
        <h2 className="section-head">Evidence Files</h2>
        <div className="control-row">
          <a href="/proof-pack/NETPULSE_PROOF_PACK.md" target="_blank" rel="noreferrer">
            <code>NETPULSE_PROOF_PACK.md</code>
          </a>
          <a href="/proof-pack/mtls-chaos-report.json" target="_blank" rel="noreferrer">
            <code>mtls-chaos-report.json</code>
          </a>
          <a href="/proof-pack/mtls-chaos.txt" target="_blank" rel="noreferrer">
            <code>mtls-chaos.txt</code>
          </a>
          <a href="/proof-pack/pgbouncer.txt" target="_blank" rel="noreferrer">
            <code>pgbouncer.txt</code>
          </a>
          <a href="/proof-pack/timeline.txt" target="_blank" rel="noreferrer">
            <code>timeline.txt</code>
          </a>
        </div>
        <div className="control-row">
          <Link href="/">Back to Home</Link>
        </div>
      </section>
    </main>
  );
}
