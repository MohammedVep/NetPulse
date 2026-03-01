import { createApiClient } from "../../../packages/shared/src/api-client";
import { config } from "./config";

async function loadToken(): Promise<string | null> {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem("netpulse_token");
}

export const apiClient = createApiClient({
  baseUrl: config.apiBaseUrl,
  getToken: loadToken
});
