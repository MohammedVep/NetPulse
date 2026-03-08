# NetPulse Reliability Proof Pack (One Page)

**Run ID:** proofpack-20260308T184847Z
**Execution Window (UTC):** 2026-03-08T18:48:47Z to 2026-03-08T18:49:36Z

## Hypothesis
If 50% of active regional workers are terminated during a 10k-event mTLS queue burst, NetPulse should:
1. detect dead workers in under 2 seconds,
2. preserve in-flight jobs via DLQ replay,
3. continue processing on live workers with zero data loss,
4. keep PostgreSQL stable under 10k concurrent-write pressure via PgBouncer pooling.

## Exact Commands Used

a. **Bring up PostgreSQL + PgBouncer**

`docker compose -f infra/high-concurrency/docker-compose.yml up -d`

b. **10k write spike via PgBouncer**

`TOTAL_WRITES=10000 WRITE_CONCURRENCY=1000 POOL_MAX_CONNECTIONS=1200 npm run drill:pgbouncer`

c. **mTLS chaos drill (50% worker outage + replay)**

`MTLS_WORKERS=4 MTLS_EVENTS_PER_WORKER=2500 MTLS_EVENT_INTERVAL_MS=2 MTLS_KILL_RATIO=0.5 MTLS_KILL_AFTER_MS=1500 npm run drill:mtls:chaos`

## Kill Command (Disaster Injection)

`chaos-injector kill regional-worker-1 regional-worker-2`

Killed workers: **regional-worker-1, regional-worker-2**

Kill timestamp: **2026-03-08T18:49:31.938Z**

## Timestamped Results

- **PgBouncer spike:** 10,000/10,000 writes completed, 0 failed, 5,564.83 writes/sec.
- **PostgreSQL connection snapshot:** total=17, active=1 (no connection exhaustion).
- **mTLS drill start:** 2026-03-08T18:49:30.391Z
- **Worker outage injected:** 2026-03-08T18:49:31.938Z
- **Dead worker detection latency:** 5ms
- **mTLS drill end:** 2026-03-08T18:49:36.424Z

## Evidence Outcomes

- **Worker health drop:** 4 workers -> 2 workers immediately after kill.
- **mTLS enforcement:** unauthorized handshake failures = 1 (client cert required).
- **Processed jobs continued after outage:**
  - before kill: 2631
  - after kill (live workers + replay): 7369
  - total processed: 10000 / expected: 10000
- **DLQ replay:** queued=3684, replayed=3684
- **Data loss:** 0
- **Observed throughput:** 1657.55 msg/s

## Grafana Evidence Points (Use These Panels)

1. **Worker Health**
   - Plot active workers: baseline=4, drop-to=2 at 2026-03-08T18:49:31.938Z.
2. **Error Rate / Security Signal**
   - Plot mTLS handshake reject events (expect spike around 2026-03-08T18:49:30.391Z).
3. **Processed Jobs**
   - Plot cumulative processed jobs; line must continue rising through outage window (2026-03-08T18:49:31.938Z to 2026-03-08T18:49:36.424Z).
4. **DLQ Replay / Recovery**
   - Plot DLQ queued vs replayed; replayed should converge to queued (here: 3684/3684).

## Raw Evidence Files

- Timeline: `/proof-pack/timeline.txt`
- PgBouncer output: `/proof-pack/pgbouncer.txt`
- mTLS chaos log: `/proof-pack/mtls-chaos.txt`
- Structured report: `/proof-pack/mtls-chaos-report.json`
