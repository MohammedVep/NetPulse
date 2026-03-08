import { Buffer } from "node:buffer";
import type { LoadBalancerConfig } from "./config.js";
import type { BackendNode } from "./types.js";

type Fetcher = typeof fetch;

export interface DiscoveryClient {
  fetchBackends(): Promise<BackendNode[]>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function ensurePath(input: string | undefined, fallback: string): string {
  const raw = input?.trim() || fallback;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function toStringMap(value: unknown): Record<string, string> {
  const obj = asObject(value);

  if (!obj) {
    return {};
  }

  return Object.entries(obj).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (typeof entry === "string") {
      acc[key] = entry;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      acc[key] = String(entry);
    }

    return acc;
  }, {});
}

function parseStaticEntry(entry: string, defaultHealthPath: string): BackendNode {
  const trimmed = entry.trim();

  if (!trimmed) {
    throw new Error("Empty backend entry");
  }

  const [idPart, targetPart] = trimmed.includes("=")
    ? [trimmed.slice(0, trimmed.indexOf("=")), trimmed.slice(trimmed.indexOf("=") + 1)]
    : [undefined, trimmed];

  let host = "";
  let port = 0;
  let healthPath = defaultHealthPath;

  if (targetPart.includes("://")) {
    const parsed = new URL(targetPart);
    host = parsed.hostname;
    port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    healthPath = ensurePath(parsed.pathname !== "/" ? parsed.pathname : undefined, defaultHealthPath);
  } else {
    const slashIndex = targetPart.indexOf("/");
    const hostPort = slashIndex >= 0 ? targetPart.slice(0, slashIndex) : targetPart;
    const configuredPath = slashIndex >= 0 ? targetPart.slice(slashIndex) : undefined;

    const colonIndex = hostPort.lastIndexOf(":");
    if (colonIndex <= 0) {
      throw new Error(`Invalid backend target \"${entry}\". Expected host:port.`);
    }

    host = hostPort.slice(0, colonIndex);
    port = Number(hostPort.slice(colonIndex + 1));
    healthPath = ensurePath(configuredPath, defaultHealthPath);
  }

  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid backend target \"${entry}\".`);
  }

  const id = idPart?.trim() || `${host}:${port}`;

  return {
    id,
    host,
    port,
    healthPath,
    metadata: {}
  };
}

function uniqueBackends(backends: BackendNode[]): BackendNode[] {
  const seen = new Set<string>();
  const unique: BackendNode[] = [];

  for (const backend of backends) {
    if (seen.has(backend.id)) {
      continue;
    }

    seen.add(backend.id);
    unique.push(backend);
  }

  return unique;
}

export function parseStaticBackends(input: string, defaultHealthPath: string): BackendNode[] {
  const parsed = input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseStaticEntry(entry, defaultHealthPath));

  return uniqueBackends(parsed);
}

export function parseConsulHealthResponse(input: unknown, defaultHealthPath: string): BackendNode[] {
  if (!Array.isArray(input)) {
    throw new Error("Consul service response was not an array");
  }

  const parsed: BackendNode[] = [];

  for (const item of input) {
    const obj = asObject(item);
    const service = asObject(obj?.Service);
    const node = asObject(obj?.Node);

    if (!service) {
      continue;
    }

    const host =
      asString(service.Address) ||
      asString(node?.Address) ||
      asString(service.TaggedAddresses && asObject(service.TaggedAddresses)?.lan);
    const port = asNumber(service.Port);

    if (!host || !port) {
      continue;
    }

    const meta = toStringMap(service.Meta);
    const healthPath = ensurePath(meta.healthPath || meta.health_path, defaultHealthPath);

    parsed.push({
      id: asString(service.ID) || asString(service.Service) || `${host}:${port}`,
      host,
      port,
      healthPath,
      metadata: meta
    });
  }

  return uniqueBackends(parsed);
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function nextPrefixEnd(prefix: string): string {
  if (!prefix) {
    return "\\0";
  }

  const bytes = Buffer.from(prefix, "utf8");

  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    const current = bytes[i];

    if (current !== undefined && current < 0xff) {
      bytes[i] = current + 1;
      return bytes.subarray(0, i + 1).toString("utf8");
    }
  }

  return "\\0";
}

function parseEtcdBackendValue(
  key: string,
  rawValue: string,
  defaultHealthPath: string
): BackendNode | undefined {
  const fallbackId = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    const obj = asObject(parsed);

    if (!obj) {
      return undefined;
    }

    const host = asString(obj.host) || asString(obj.address) || asString(obj.ip);
    const port = asNumber(obj.port);

    if (!host || !port) {
      return undefined;
    }

    const metadata = toStringMap(obj.metadata);

    return {
      id: asString(obj.id) || fallbackId || `${host}:${port}`,
      host,
      port,
      healthPath: ensurePath(asString(obj.healthPath) || asString(obj.health_path), defaultHealthPath),
      metadata
    };
  } catch {
    const parts = rawValue.split(":");
    if (parts.length !== 2) {
      return undefined;
    }

    const host = parts[0]?.trim() || "";
    const port = Number(parts[1]);

    if (!host || !Number.isInteger(port) || port <= 0) {
      return undefined;
    }

    return {
      id: fallbackId || `${host}:${port}`,
      host,
      port,
      healthPath: defaultHealthPath,
      metadata: {}
    };
  }
}

export function parseEtcdRangeResponse(input: unknown, defaultHealthPath: string): BackendNode[] {
  const obj = asObject(input);
  const kvs = Array.isArray(obj?.kvs) ? obj.kvs : [];
  const parsed: BackendNode[] = [];

  for (const entry of kvs) {
    const kv = asObject(entry);
    const keyEncoded = asString(kv?.key);
    const valueEncoded = asString(kv?.value);

    if (!keyEncoded || !valueEncoded) {
      continue;
    }

    const decoded = parseEtcdBackendValue(
      decodeBase64(keyEncoded),
      decodeBase64(valueEncoded),
      defaultHealthPath
    );

    if (!decoded) {
      continue;
    }

    parsed.push(decoded);
  }

  return uniqueBackends(parsed);
}

async function fetchJson(fetcher: Fetcher, input: URL | string, init?: RequestInit): Promise<unknown> {
  const response = await fetcher(input, init);

  if (!response.ok) {
    throw new Error(`Discovery request failed with status ${response.status}`);
  }

  return response.json();
}

export function createDiscoveryClient(config: LoadBalancerConfig, fetcher: Fetcher = fetch): DiscoveryClient {
  if (config.discovery.provider === "static") {
    return {
      async fetchBackends(): Promise<BackendNode[]> {
        if (!config.discovery.staticBackends) {
          return [];
        }

        return parseStaticBackends(config.discovery.staticBackends, config.health.defaultPath);
      }
    };
  }

  if (config.discovery.provider === "consul") {
    return {
      async fetchBackends(): Promise<BackendNode[]> {
        const url = new URL(
          `/v1/health/service/${encodeURIComponent(config.discovery.consulServiceName)}`,
          config.discovery.consulUrl
        );
        url.searchParams.set("passing", "true");
        if (config.discovery.consulDatacenter) {
          url.searchParams.set("dc", config.discovery.consulDatacenter);
        }

        const payload = await fetchJson(fetcher, url);
        return parseConsulHealthResponse(payload, config.health.defaultPath);
      }
    };
  }

  return {
    async fetchBackends(): Promise<BackendNode[]> {
      const key = config.discovery.etcdKeyPrefix;
      const payload = {
        key: encodeBase64(key),
        range_end: encodeBase64(nextPrefixEnd(key))
      };

      const response = await fetchJson(fetcher, `${config.discovery.etcdUrl}/v3/kv/range`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      return parseEtcdRangeResponse(response, config.health.defaultPath);
    }
  };
}
