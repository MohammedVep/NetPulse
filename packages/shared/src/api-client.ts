import type {
  AlertChannel,
  DashboardSummary,
  Endpoint,
  EndpointSlaReport,
  EndpointMetrics,
  Incident,
  IncidentTimeline,
  Membership,
  MonitoringRegion,
  OrgAiInsights,
  Organization,
  ProbeResult,
  SimulationRequest,
  SimulationResponse
} from "./types.js";

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  mapPath?: (path: string) => string;
}

const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_BACKOFF_MS = 150;
const MAX_RETRY_BACKOFF_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryBackoffMs(attempt: number): number {
  const exp = Math.min(MAX_RETRY_BACKOFF_MS, BASE_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return exp + Math.floor(Math.random() * 100);
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function parseRetryAfterSeconds(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const asDate = Date.parse(retryAfter);
  if (!Number.isNaN(asDate)) {
    const deltaMs = asDate - Date.now();
    return deltaMs > 0 ? Math.ceil(deltaMs / 1000) : 0;
  }

  return null;
}

async function request<T>(
  options: ApiClientOptions,
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = await options.getToken();
  const resolvedPath = options.mapPath ? options.mapPath(path) : path;
  const method = (init?.method ?? "GET").toUpperCase();
  const retryableMethod = method === "GET" || method === "HEAD";

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${options.baseUrl}${resolvedPath}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {})
        }
      });

      if (!response.ok) {
        const retryableStatus = retryableMethod && shouldRetryStatus(response.status) && attempt < MAX_RETRY_ATTEMPTS;
        if (retryableStatus) {
          const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
          const delayMs =
            retryAfterSeconds !== null
              ? Math.min(MAX_RETRY_BACKOFF_MS, retryAfterSeconds * 1000)
              : retryBackoffMs(attempt);
          await sleep(delayMs);
          continue;
        }

        const text = await response.text();
        throw new Error(`API ${response.status}: ${text}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      const isApiResponseError = error instanceof Error && error.message.startsWith("API ");
      if (isApiResponseError) {
        throw error;
      }

      if (attempt < MAX_RETRY_ATTEMPTS && retryableMethod) {
        await sleep(retryBackoffMs(attempt));
        continue;
      }

      throw error;
    }
  }

  throw new Error("API request failed after retry attempts");
}

export function createApiClient(options: ApiClientOptions) {
  return {
    createOrganization: (name: string) =>
      request<Organization>(options, "/v1/organizations", {
        method: "POST",
        body: JSON.stringify({ name })
      }),
    getOrganization: (orgId: string) => request<Organization>(options, `/v1/organizations/${orgId}`),
    upsertMember: (orgId: string, payload: Partial<Membership> & { userId: string; email: string }) =>
      request<Membership>(options, `/v1/organizations/${orgId}/members`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    patchMember: (
      orgId: string,
      memberId: string,
      payload: Partial<Pick<Membership, "role" | "isActive">>
    ) =>
      request<Membership>(options, `/v1/organizations/${orgId}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    createEndpoint: (
      payload: Pick<Endpoint, "orgId" | "name" | "url" | "timeoutMs" | "tags"> & {
        checkRegions?: MonitoringRegion[];
        slaTargetPct?: number;
        latencyThresholdMs?: number;
        failureRateThresholdPct?: number;
      }
    ) =>
      request<Endpoint>(options, "/v1/endpoints", {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    listEndpoints: (orgId: string, cursor?: string, limit = 50) => {
      const qs = new URLSearchParams({ orgId, limit: String(limit) });
      if (cursor) qs.set("cursor", cursor);
      return request<{ items: Endpoint[]; nextCursor?: string }>(options, `/v1/endpoints?${qs.toString()}`);
    },
    getEndpoint: (endpointId: string) => request<Endpoint>(options, `/v1/endpoints/${endpointId}`),
    patchEndpoint: (endpointId: string, payload: Partial<Endpoint>) =>
      request<Endpoint>(options, `/v1/endpoints/${endpointId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    deleteEndpoint: (endpointId: string) =>
      request<void>(options, `/v1/endpoints/${endpointId}`, { method: "DELETE" }),
    getChecks: (endpointId: string, from: string, to: string, cursor?: string) => {
      const qs = new URLSearchParams({ from, to });
      if (cursor) qs.set("cursor", cursor);
      return request<{ items: ProbeResult[]; nextCursor?: string }>(
        options,
        `/v1/endpoints/${endpointId}/checks?${qs.toString()}`
      );
    },
    getMetrics: (endpointId: string, window: "24h" | "7d" | "30d") =>
      request<EndpointMetrics>(options, `/v1/endpoints/${endpointId}/metrics?window=${window}`),
    getSlaReport: (endpointId: string, window: "24h" | "7d" | "30d") =>
      request<EndpointSlaReport>(options, `/v1/endpoints/${endpointId}/sla?window=${window}`),
    setFailureSimulation: (endpointId: string, payload: SimulationRequest) =>
      request<SimulationResponse>(options, `/v1/endpoints/${endpointId}/simulate`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    clearFailureSimulation: (endpointId: string) =>
      request<SimulationResponse>(options, `/v1/endpoints/${endpointId}/simulate`, {
        method: "POST",
        body: JSON.stringify({ mode: "CLEAR" })
      }),
    listIncidents: (orgId: string, status?: "open" | "resolved", cursor?: string) => {
      const qs = new URLSearchParams({ orgId });
      if (status) qs.set("status", status);
      if (cursor) qs.set("cursor", cursor);
      return request<{ items: Incident[]; nextCursor?: string }>(options, `/v1/incidents?${qs.toString()}`);
    },
    getIncidentTimeline: (incidentId: string, limit = 100) => {
      const qs = new URLSearchParams({ limit: String(limit) });
      return request<IncidentTimeline>(options, `/v1/incidents/${incidentId}/timeline?${qs.toString()}`);
    },
    registerEmailChannel: (orgId: string, email: string) =>
      request<AlertChannel>(options, "/v1/alert-channels/email", {
        method: "POST",
        body: JSON.stringify({ orgId, email })
      }),
    registerSlackChannel: (orgId: string, webhookUrl: string) =>
      request<AlertChannel>(options, "/v1/alert-channels/slack", {
        method: "POST",
        body: JSON.stringify({ orgId, webhookUrl })
      }),
    registerWebhookChannel: (
      orgId: string,
      payload: {
        name: string;
        url: string;
        events?: Array<
          "INCIDENT_OPEN" | "INCIDENT_RESOLVED" | "SLO_BURN_RATE" | "LATENCY_BREACH" | "FAILURE_RATE_BREACH"
        >;
        secretHeaderName?: string;
        secretHeaderValue?: string;
      }
    ) =>
      request<AlertChannel>(options, "/v1/alert-channels/webhook", {
        method: "POST",
        body: JSON.stringify({ orgId, ...payload })
      }),
    getDashboardSummary: (orgId: string, window: "24h" | "7d" | "30d") =>
      request<DashboardSummary>(options, `/v1/dashboard/summary?orgId=${orgId}&window=${window}`),
    getAiInsights: (orgId: string, window: "24h" | "7d" | "30d") =>
      request<OrgAiInsights>(options, `/v1/ai/insights?orgId=${orgId}&window=${window}`)
  };
}
