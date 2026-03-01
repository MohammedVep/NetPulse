import { randomUUID } from "node:crypto";

export function makeOrgId(): string {
  return `org_${randomUUID()}`;
}

export function makeEndpointId(orgId: string): string {
  return `${orgId}__ep_${randomUUID()}`;
}

export function makeIncidentId(): string {
  return `inc_${randomUUID()}`;
}

export function makeChannelId(prefix: "email" | "slack" | "webhook"): string {
  return `${prefix}_${randomUUID()}`;
}

export function getOrgIdFromEndpointId(endpointId: string): string {
  const index = endpointId.indexOf("__");

  if (index <= 0) {
    throw new Error("Invalid endpointId format");
  }

  return endpointId.slice(0, index);
}
