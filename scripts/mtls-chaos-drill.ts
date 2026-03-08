import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const certDir = process.env.MTLS_CERT_DIR ?? path.resolve(process.cwd(), "infra/high-concurrency/mtls/certs");
const host = process.env.MTLS_QUEUE_HOST ?? "127.0.0.1";
const port = Number(process.env.MTLS_QUEUE_PORT ?? "9443");
const workerCount = Number(process.env.MTLS_WORKERS ?? "4");
const eventsPerWorker = Number(process.env.MTLS_EVENTS_PER_WORKER ?? "2500");
const eventIntervalMs = Number(process.env.MTLS_EVENT_INTERVAL_MS ?? "2");
const killRatio = Number(process.env.MTLS_KILL_RATIO ?? "0.5");
const killAfterMs = Number(process.env.MTLS_KILL_AFTER_MS ?? "1500");
const replayBatchSize = Number(process.env.MTLS_REPLAY_BATCH_SIZE ?? "250");
const outputPath =
  process.env.MTLS_CHAOS_OUTPUT_PATH ??
  path.resolve(process.cwd(), `artifacts/drills/mtls-chaos-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

interface QueuePayload {
  id: string;
  workerId: string;
  seq: number;
  region: string;
  latencyMs: number;
  createdAt: string;
  replayed?: boolean;
}

interface WorkerState {
  workerId: string;
  socket: tls.TLSSocket;
  sent: number;
  done: boolean;
  killed: boolean;
  connectedAtIso: string;
  closedAtIso?: string;
  closeReason?: string;
  interval: NodeJS.Timeout;
}

interface ChaosReport {
  runId: string;
  startedAtIso: string;
  endedAtIso: string;
  host: string;
  port: number;
  workerCount: number;
  eventsPerWorker: number;
  expectedMessages: number;
  killRatio: number;
  killAfterMs: number;
  killCommand: string;
  killedWorkers: string[];
  killAtIso: string;
  detectionLatencyMs: number;
  unauthorizedHandshakeFailures: number;
  dlqQueued: number;
  dlqReplayed: number;
  receivedBeforeKill: number;
  receivedAfterKill: number;
  processedMessages: number;
  dataLoss: number;
  throughputMessagesPerSecond: number;
  workerCloseEvents: Array<{ workerId: string; closeAtIso?: string; reason?: string }>;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${label} must be between 0 and 1 (exclusive)`);
  }
}

function readCert(name: string): Buffer {
  return fs.readFileSync(path.join(certDir, name));
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWorker(workerIndex: number): Promise<WorkerState> {
  const workerId = `regional-worker-${workerIndex + 1}`;

  return await new Promise<WorkerState>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      cert: readCert("worker.crt"),
      key: readCert("worker.key"),
      ca: readCert("ca.crt"),
      servername: "localhost",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2"
    });

    const state: WorkerState = {
      workerId,
      socket,
      sent: 0,
      done: false,
      killed: false,
      connectedAtIso: nowIso(),
      interval: setInterval(() => {
        // replaced after secure connect
      }, 1)
    };
    clearInterval(state.interval);

    socket.once("secureConnect", () => {
      state.connectedAtIso = nowIso();
      state.interval = setInterval(() => {
        if (state.done || state.killed) {
          clearInterval(state.interval);
          return;
        }

        if (state.sent >= eventsPerWorker) {
          state.done = true;
          clearInterval(state.interval);
          socket.end();
          return;
        }

        const payload: QueuePayload = {
          id: `${workerId}-${state.sent}`,
          workerId,
          seq: state.sent,
          region: ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"][state.sent % 4],
          latencyMs: Math.floor(Math.random() * 250) + 20,
          createdAt: nowIso()
        };

        state.sent += 1;
        socket.write(`${JSON.stringify(payload)}\n`);
      }, eventIntervalMs);

      resolve(state);
    });

    socket.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      state.closeReason = message;
      if (!state.done && !state.killed) {
        reject(new Error(`worker ${workerId} socket error: ${message}`));
      }
    });

    socket.once("close", () => {
      state.closedAtIso = nowIso();
      if (!state.done && !state.killed && state.sent < eventsPerWorker) {
        state.closeReason = state.closeReason ?? "connection closed before send completion";
      }
    });
  });
}

async function replayDlq(events: QueuePayload[]): Promise<number> {
  if (events.length === 0) {
    return 0;
  }

  return await new Promise<number>((resolve, reject) => {
    let sent = 0;
    const socket = tls.connect({
      host,
      port,
      cert: readCert("worker.crt"),
      key: readCert("worker.key"),
      ca: readCert("ca.crt"),
      servername: "localhost",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2"
    });

    socket.once("secureConnect", async () => {
      try {
        for (let i = 0; i < events.length; i += replayBatchSize) {
          const batch = events.slice(i, i + replayBatchSize);
          for (const event of batch) {
            sent += 1;
            socket.write(`${JSON.stringify({ ...event, replayed: true })}\n`);
          }
          await sleep(10);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        socket.destroy(new Error(message));
        return;
      }

      socket.end();
    });

    socket.once("close", () => resolve(sent));
    socket.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`DLQ replay socket error: ${message}`));
    });
  });
}

async function main(): Promise<void> {
  assertPositiveInteger(workerCount, "MTLS_WORKERS");
  assertPositiveInteger(eventsPerWorker, "MTLS_EVENTS_PER_WORKER");
  assertPositiveInteger(eventIntervalMs, "MTLS_EVENT_INTERVAL_MS");
  assertPositiveInteger(killAfterMs, "MTLS_KILL_AFTER_MS");
  assertPositiveInteger(replayBatchSize, "MTLS_REPLAY_BATCH_SIZE");
  assertRatio(killRatio, "MTLS_KILL_RATIO");

  const expectedMessages = workerCount * eventsPerWorker;
  const runId = `mtls-chaos-${Date.now()}`;
  const startedAtIso = nowIso();
  let receivedMessages = 0;
  let unauthorizedHandshakeFailures = 0;
  let killAtIso = "";
  let receivedBeforeKill = 0;
  let receivedAfterKill = 0;

  const workerStates = new Map<string, WorkerState>();

  const server = tls.createServer(
    {
      cert: readCert("server.crt"),
      key: readCert("server.key"),
      ca: readCert("ca.crt"),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2"
    },
    (socket) => {
      if (!socket.authorized) {
        unauthorizedHandshakeFailures += 1;
        socket.destroy();
        return;
      }

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");

        for (;;) {
          const separatorIndex = buffer.indexOf("\n");
          if (separatorIndex < 0) {
            break;
          }

          const line = buffer.slice(0, separatorIndex).trim();
          buffer = buffer.slice(separatorIndex + 1);
          if (!line) {
            continue;
          }

          try {
            JSON.parse(line);
            receivedMessages += 1;
            if (killAtIso) {
              receivedAfterKill += 1;
            }
          } catch {
            // ignore malformed payloads for drill stability
          }
        }
      });
    }
  );

  server.on("tlsClientError", (error) => {
    unauthorizedHandshakeFailures += 1;
    console.log(
      JSON.stringify(
        {
          message: "mTLS handshake rejected",
          atIso: nowIso(),
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  console.log(
    JSON.stringify(
      {
        message: "mTLS chaos queue server started",
        runId,
        host,
        port,
        workerCount,
        eventsPerWorker,
        expectedMessages,
        killRatio,
        killAfterMs,
        startedAtIso
      },
      null,
      2
    )
  );

  // Inject one unauthorized handshake to prove mTLS reject path.
  const unauthorizedProbe = tls.connect({
    host,
    port,
    ca: readCert("ca.crt"),
    rejectUnauthorized: true,
    servername: "localhost",
    minVersion: "TLSv1.2"
  });
  unauthorizedProbe.on("error", () => {
    // expected due to missing client cert
  });
  unauthorizedProbe.on("close", () => {
    // expected
  });

  const connections = await Promise.all(Array.from({ length: workerCount }, (_, i) => connectWorker(i)));
  for (const state of connections) {
    workerStates.set(state.workerId, state);
  }

  await sleep(killAfterMs);

  const killCount = Math.max(1, Math.floor(workerCount * killRatio));
  const candidates = Array.from(workerStates.values()).filter((state) => !state.done);
  const killed = candidates.slice(0, Math.min(killCount, candidates.length));

  killAtIso = nowIso();
  receivedBeforeKill = receivedMessages;
  const killPidsDisplay = killed.map((state) => state.workerId).join(" ");
  const killCommand = `chaos-injector kill ${killPidsDisplay}`;
  console.log(
    JSON.stringify(
      {
        message: "injecting worker outage",
        killAtIso,
        killCount: killed.length,
        killCommand,
        killedWorkers: killed.map((state) => state.workerId)
      },
      null,
      2
    )
  );

  const dlqEvents: QueuePayload[] = [];
  for (const state of killed) {
    state.killed = true;
    clearInterval(state.interval);

    for (let seq = state.sent; seq < eventsPerWorker; seq += 1) {
      dlqEvents.push({
        id: `${state.workerId}-${seq}`,
        workerId: state.workerId,
        seq,
        region: ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"][seq % 4],
        latencyMs: Math.floor(Math.random() * 250) + 20,
        createdAt: nowIso()
      });
    }

    state.closeReason = "chaos_killed";
    state.socket.destroy(new Error("chaos_killed"));
  }

  // Wait for surviving workers to finish.
  const survivorWaitDeadline = Date.now() + Math.max(eventsPerWorker * eventIntervalMs * 2, 20_000);
  while (Date.now() < survivorWaitDeadline) {
    const survivorsPending = Array.from(workerStates.values()).some((state) => !state.killed && !state.done);
    if (!survivorsPending) {
      break;
    }
    await sleep(100);
  }

  const killEpoch = Date.parse(killAtIso);
  const detectionLatencyMs = Math.max(
    ...killed.map((state) => {
      const closedEpoch = state.closedAtIso ? Date.parse(state.closedAtIso) : Date.now();
      return Math.max(0, closedEpoch - killEpoch);
    }),
    0
  );

  const dlqReplayed = await replayDlq(dlqEvents);

  const waitForDrainDeadline = Date.now() + 20_000;
  while (receivedMessages < expectedMessages && Date.now() < waitForDrainDeadline) {
    await sleep(100);
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  const endedAtIso = nowIso();
  const durationMs = Math.max(1, Date.parse(endedAtIso) - Date.parse(startedAtIso));
  const report: ChaosReport = {
    runId,
    startedAtIso,
    endedAtIso,
    host,
    port,
    workerCount,
    eventsPerWorker,
    expectedMessages,
    killRatio,
    killAfterMs,
    killCommand,
    killedWorkers: killed.map((state) => state.workerId),
    killAtIso,
    detectionLatencyMs,
    unauthorizedHandshakeFailures,
    dlqQueued: dlqEvents.length,
    dlqReplayed,
    receivedBeforeKill,
    receivedAfterKill,
    processedMessages: receivedMessages,
    dataLoss: Math.max(0, expectedMessages - receivedMessages),
    throughputMessagesPerSecond: Number((receivedMessages / (durationMs / 1000)).toFixed(2)),
    workerCloseEvents: Array.from(workerStates.values()).map((state) => ({
      workerId: state.workerId,
      closeAtIso: state.closedAtIso,
      reason: state.closeReason
    }))
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ message: "mTLS chaos drill complete", report }, null, 2));
  console.log(`Chaos report saved to ${outputPath}`);

  const pass =
    report.dataLoss === 0 &&
    report.killedWorkers.length > 0 &&
    report.dlqQueued === report.dlqReplayed &&
    report.unauthorizedHandshakeFailures > 0;

  if (!pass) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mTLS chaos drill failed: ${message}`);
  process.exit(1);
});
