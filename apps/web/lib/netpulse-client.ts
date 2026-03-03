import { createApiClient } from "../../../packages/shared/src/api-client";
import { config } from "./config";

type NetPulseClient = ReturnType<typeof createApiClient>;

const READ_ONLY_METHODS = new Set<keyof NetPulseClient>([
  "getOrganization",
  "listEndpoints",
  "getEndpoint",
  "getChecks",
  "getMetrics",
  "getSlaReport",
  "listIncidents",
  "getIncidentTimeline",
  "getDashboardSummary",
  "getAiInsights"
]);

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = parts[1];
    if (!payload) {
      return null;
    }
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = atob(`${normalized}${padding}`);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getValidTokenFromStorage(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const token = window.localStorage.getItem("netpulse_token");
  if (!token) {
    return null;
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    window.localStorage.removeItem("netpulse_token");
    return null;
  }

  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp && exp * 1000 <= Date.now()) {
    window.localStorage.removeItem("netpulse_token");
    return null;
  }

  return token;
}

function hasStoredToken(): boolean {
  return Boolean(getValidTokenFromStorage());
}

async function loadToken(): Promise<string | null> {
  return getValidTokenFromStorage();
}

function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("API 401");
}

const authenticatedClient = createApiClient({
  baseUrl: config.apiBaseUrl,
  getToken: loadToken
});

const publicClient = createApiClient({
  baseUrl: config.apiBaseUrl,
  getToken: async () => null,
  mapPath: (path) => path.replace(/^\/v1/, "/v1/public")
});

export function hasAuthToken(): boolean {
  return hasStoredToken();
}

export const apiClient = new Proxy(authenticatedClient, {
  get(_target, prop, _receiver) {
    const key = prop as keyof NetPulseClient;
    const authValue = authenticatedClient[key];
    const publicValue = publicClient[key];

    if (typeof authValue !== "function") {
      return authValue;
    }

    return async (...args: unknown[]) => {
      if (!READ_ONLY_METHODS.has(key)) {
        return (authValue as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
      }

      const token = getValidTokenFromStorage();
      if (!token) {
        return (publicValue as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
      }

      try {
        return await (authValue as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
      } catch (error) {
        if (isUnauthorizedError(error) && typeof window !== "undefined") {
          window.localStorage.removeItem("netpulse_token");
          return (publicValue as (...innerArgs: unknown[]) => Promise<unknown>)(...args);
        }

        throw error;
      }
    };
  }
}) as NetPulseClient;
