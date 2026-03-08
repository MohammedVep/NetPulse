import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { BackendRuntime } from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function requestMethod(request: IncomingMessage): string {
  return (request.method || "GET").toUpperCase();
}

function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function copyRequestHeaders(request: IncomingMessage, backend: BackendRuntime): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "host") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  const remoteAddress = request.socket.remoteAddress || "unknown";
  const priorForwardedFor = request.headers["x-forwarded-for"];
  const forwardedFor = Array.isArray(priorForwardedFor)
    ? [...priorForwardedFor, remoteAddress].join(",")
    : typeof priorForwardedFor === "string" && priorForwardedFor.length > 0
      ? `${priorForwardedFor},${remoteAddress}`
      : remoteAddress;
  const socket = request.socket as typeof request.socket & { encrypted?: boolean };

  headers.set("x-forwarded-for", forwardedFor);
  headers.set("x-forwarded-proto", socket.encrypted ? "https" : "http");
  headers.set("x-forwarded-host", request.headers.host || `${backend.host}:${backend.port}`);
  headers.set("host", `${backend.host}:${backend.port}`);

  return headers;
}

export async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  backend: BackendRuntime,
  timeoutMs: number
): Promise<number> {
  const method = requestMethod(request);
  const path = request.url || "/";
  const targetUrl = new URL(path, `http://${backend.host}:${backend.port}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: copyRequestHeaders(request, backend),
      redirect: "manual",
      signal: controller.signal
    };

    if (hasBody(method)) {
      init.body = Readable.toWeb(request) as unknown as BodyInit;
      init.duplex = "half";
    }

    const upstream = await fetch(targetUrl, init);

    response.statusCode = upstream.status;

    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
        response.setHeader(name, value);
      }
    });

    if (!upstream.body || method === "HEAD") {
      response.end();
      await once(response, "finish");
      return upstream.status;
    }

    const body = Readable.fromWeb(upstream.body as never);
    body.on("error", (error) => {
      response.destroy(error as Error);
    });
    body.pipe(response);
    await Promise.race([once(response, "finish"), once(response, "close")]);

    return upstream.status;
  } finally {
    clearTimeout(timeout);
  }
}
