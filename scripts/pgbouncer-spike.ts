import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl =
  process.env.PGBOUNCER_DATABASE_URL ?? "postgresql://netpulse:netpulse_dev_password@127.0.0.1:6432/netpulse";
const adminUrl =
  process.env.PGBOUNCER_ADMIN_URL ?? "postgresql://netpulse:netpulse_dev_password@127.0.0.1:6432/pgbouncer";
const totalWrites = Number(process.env.TOTAL_WRITES ?? "10000");
const concurrency = Number(process.env.WRITE_CONCURRENCY ?? "1000");
const poolMax = Number(process.env.POOL_MAX_CONNECTIONS ?? "1500");

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

const regions = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"] as const;

async function runWriteBurst(pool: Pool): Promise<{ completed: number; failed: number; errors: string[] }> {
  let completed = 0;
  let failed = 0;
  const errors: string[] = [];

  const workers = Array.from({ length: concurrency }, (_, workerIndex) =>
    (async () => {
      for (let i = workerIndex; i < totalWrites; i += concurrency) {
        const region = regions[i % regions.length];
        try {
          await pool.query(
            `INSERT INTO regional_check_results (worker_id, region, status_code, latency_ms)
             VALUES ($1, $2, $3, $4)`,
            [`worker-${workerIndex}-${randomUUID()}`, region, 200, Math.floor(Math.random() * 250) + 20]
          );
          completed += 1;
        } catch (error) {
          failed += 1;
          if (errors.length < 5) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
          }
        }
      }
    })()
  );

  await Promise.all(workers);
  return { completed, failed, errors };
}

async function showPoolStats(): Promise<void> {
  const adminPool = new Pool({
    connectionString: adminUrl,
    max: 2
  });

  try {
    const result = await adminPool.query("SHOW POOLS;");
    const netpulsePool = result.rows.find((row) => row.database === "netpulse");
    if (netpulsePool) {
      console.log(
        JSON.stringify(
          {
            message: "PgBouncer pool stats",
            database: netpulsePool.database,
            clActive: Number(netpulsePool.cl_active),
            clWaiting: Number(netpulsePool.cl_waiting),
            svActive: Number(netpulsePool.sv_active),
            svIdle: Number(netpulsePool.sv_idle),
            maxwaitSeconds: Number(netpulsePool.maxwait)
          },
          null,
          2
        )
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not fetch PgBouncer pool stats: ${message}`);
  } finally {
    await adminPool.end();
  }
}

async function showPostgresConnectionStats(pool: Pool): Promise<void> {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total_connections,
       COUNT(*) FILTER (WHERE state = 'active')::int AS active_connections
     FROM pg_stat_activity
     WHERE usename = 'netpulse'`
  );

  console.log(
    JSON.stringify(
      {
        message: "PostgreSQL connection snapshot",
        totalConnections: result.rows[0]?.total_connections ?? 0,
        activeConnections: result.rows[0]?.active_connections ?? 0
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  assertPositiveInteger(totalWrites, "TOTAL_WRITES");
  assertPositiveInteger(concurrency, "WRITE_CONCURRENCY");
  assertPositiveInteger(poolMax, "POOL_MAX_CONNECTIONS");

  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS regional_check_results (
        id BIGSERIAL PRIMARY KEY,
        worker_id TEXT NOT NULL,
        region TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const startedAt = Date.now();
    const { completed, failed, errors } = await runWriteBurst(pool);
    const durationMs = Date.now() - startedAt;

    console.log(
      JSON.stringify(
        {
          message: "PgBouncer spike run complete",
          totalWrites,
          concurrency,
          completed,
          failed,
          durationMs,
          writesPerSecond: Number((completed / Math.max(durationMs / 1000, 0.001)).toFixed(2)),
          sampleErrors: errors
        },
        null,
        2
      )
    );

    await showPoolStats();
    await showPostgresConnectionStats(pool);

    if (completed < totalWrites) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`PgBouncer spike run failed: ${message}`);
  process.exit(1);
});
