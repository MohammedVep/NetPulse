import type {
  AlertChannel,
  DashboardSummary,
  Endpoint,
  EndpointSlaReport,
  EndpointMetrics,
  FailureSimulation,
  Incident,
  Membership,
  MonitoringRegion,
  Organization,
  ProbeResult
} from "./types.js";

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  mapPath?: (path: string) => string;
}

async function request<T>(
  options: ApiClientOptions,
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = await options.getToken();
  const resolvedPath = options.mapPath ? options.mapPath(path) : path;
  const response = await fetch(`${options.baseUrl}${resolvedPath}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
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
    setFailureSimulation: (endpointId: string, payload: FailureSimulation & { mode: Exclude<FailureSimulation["mode"], "NONE"> }) =>
      request<Endpoint>(options, `/v1/endpoints/${endpointId}/simulate`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    clearFailureSimulation: (endpointId: string) =>
      request<Endpoint>(options, `/v1/endpoints/${endpointId}/simulate`, { method: "DELETE" }),
    listIncidents: (orgId: string, status?: "open" | "resolved", cursor?: string) => {
      const qs = new URLSearchParams({ orgId });
      if (status) qs.set("status", status);
      if (cursor) qs.set("cursor", cursor);
      return request<{ items: Incident[]; nextCursor?: string }>(options, `/v1/incidents?${qs.toString()}`);
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
    registerWebhookChannel: (orgId: string, webhookUrl: string) =>
      request<AlertChannel>(options, "/v1/alert-channels/webhook", {
        method: "POST",
        body: JSON.stringify({ orgId, webhookUrl })
      }),
    getDashboardSummary: (orgId: string, window: "24h" | "7d" | "30d") =>
      request<DashboardSummary>(options, `/v1/dashboard/summary?orgId=${orgId}&window=${window}`)
  };
}
