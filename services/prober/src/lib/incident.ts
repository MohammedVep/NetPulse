import type { EndpointStatus } from "@netpulse/shared";

export function nextEndpointStatus(ok: boolean): EndpointStatus {
  return ok ? "HEALTHY" : "DOWN";
}

export function nextConsecutiveFailures(previous: number, ok: boolean): number {
  return ok ? 0 : previous + 1;
}

export function shouldOpenIncident(consecutiveFailures: number): boolean {
  return consecutiveFailures >= 2;
}

export function shouldResolveIncident(hasOpenIncident: boolean, ok: boolean): boolean {
  return hasOpenIncident && ok;
}
