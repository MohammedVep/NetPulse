import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const certDir = process.env.MTLS_CERT_DIR ?? path.resolve(process.cwd(), "infra/high-concurrency/mtls/certs");
const host = process.env.MTLS_QUEUE_HOST ?? "127.0.0.1";
const port = Number(process.env.MTLS_QUEUE_PORT ?? "9443");
const workerCount = Number(process.env.MTLS_WORKERS ?? "100");
const eventsPerWorker = Number(process.env.MTLS_EVENTS_PER_WORKER ?? "25");
const connectConcurrency = Number(process.env.MTLS_CONNECT_CONCURRENCY ?? "25");

interface CheckPayload {
  id: string;
  workerId: string;
  region: string;
  latencyMs: number;
  createdAt: string;
}

function readFile(name: string): Buffer {
  return fs.readFileSync(path.join(certDir, name));
}

async function sendWorkerPayloads(workerIndex: number, totalEvents: number): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const socket = tls.connect({
      host,
      port,
      cert: readFile("worker.crt"),
      key: readFile("worker.key"),
      ca: readFile("ca.crt"),
      servername: "localhost",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2"
    });
    const timeoutHandle = setTimeout(() => {
      socket.destroy(new Error(`worker ${workerIndex} timed out waiting for mTLS queue handshake/flush`));
    }, 20_000);

    socket.once("secureConnect", () => {
      for (let i = 0; i < totalEvents; i += 1) {
        const payload: CheckPayload = {
          id: `${workerIndex}-${i}`,
          workerId: `regional-worker-${workerIndex}`,
          region: ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"][i % 4],
          latencyMs: Math.floor(Math.random() * 250) + 20,
          createdAt: new Date().toISOString()
        };
        socket.write(`${JSON.stringify(payload)}\n`);
      }
      socket.end(() => finish());
    });

    socket.once("error", (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      finish(normalized);
    });
    socket.once("close", () => finish());
  });
}

async function main(): Promise<void> {
  const expectedMessages = workerCount * eventsPerWorker;
  let receivedMessages = 0;
  let deniedConnections = 0;
  const regionCounts = new Map<string, number>();

  const server = tls.createServer(
    {
      cert: readFile("server.crt"),
      key: readFile("server.key"),
      ca: readFile("ca.crt"),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2"
    },
    (socket) => {
      if (!socket.authorized) {
        deniedConnections += 1;
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
            const payload = JSON.parse(line) as CheckPayload;
            receivedMessages += 1;
            regionCounts.set(payload.region, (regionCounts.get(payload.region) ?? 0) + 1);
            socket.write(`{"ack":true,"id":"${payload.id}"}\n`);
          } catch {
            socket.write('{"ack":false,"error":"invalid-json"}\n');
          }
        }
      });

      socket.on("end", () => {
        socket.end();
      });
    }
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  console.log(
    JSON.stringify(
      {
        message: "mTLS queue server started",
        host,
        port,
        workerCount,
        eventsPerWorker,
        expectedMessages
      },
      null,
      2
    )
  );

  const startedAt = Date.now();
  for (let start = 0; start < workerCount; start += connectConcurrency) {
    const batch = Array.from(
      { length: Math.min(connectConcurrency, workerCount - start) },
      (_, offset) => sendWorkerPayloads(start + offset, eventsPerWorker)
    );
    await Promise.all(batch);
  }

  const waitDeadline = Date.now() + 15_000;
  while (receivedMessages < expectedMessages && Date.now() < waitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const durationMs = Date.now() - startedAt;
  server.close();

  const summary = {
    message: "mTLS queue drill complete",
    expectedMessages,
    receivedMessages,
    deniedConnections,
    durationMs,
    messagesPerSecond: Number((receivedMessages / Math.max(durationMs / 1000, 0.001)).toFixed(2)),
    regionCounts: Object.fromEntries(regionCounts)
  };

  console.log(JSON.stringify(summary, null, 2));

  if (receivedMessages !== expectedMessages || deniedConnections > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mTLS queue drill failed: ${message}`);
  process.exit(1);
});
