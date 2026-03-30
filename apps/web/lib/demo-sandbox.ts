import type { Endpoint, Organization } from "../../../packages/shared/src/types";
import { apiClient } from "./netpulse-client";
import { config } from "./config";

export interface SandboxCloneResult {
  organization: Organization;
  sourceEndpointCount: number;
  clonedEndpointCount: number;
  failedEndpointNames: string[];
}

function buildCloneName(name?: string): string {
  const trimmed = name?.trim();
  if (trimmed) {
    return trimmed;
  }

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${config.defaultWorkspaceName} ${stamp}`;
}

function toClonedEndpointPayload(endpoint: Endpoint, orgId: string) {
  return {
    orgId,
    name: endpoint.name,
    url: endpoint.url,
    timeoutMs: endpoint.timeoutMs,
    tags: endpoint.tags,
    checkRegions: endpoint.checkRegions,
    slaTargetPct: endpoint.slaTargetPct,
    ...(endpoint.latencyThresholdMs !== undefined ? { latencyThresholdMs: endpoint.latencyThresholdMs } : {}),
    ...(endpoint.failureRateThresholdPct !== undefined
      ? { failureRateThresholdPct: endpoint.failureRateThresholdPct }
      : {})
  };
}

async function listAllDemoEndpoints(): Promise<Endpoint[]> {
  const items: Endpoint[] = [];
  let cursor: string | undefined;

  do {
    const page = await apiClient.listEndpoints(config.demoOrgId, cursor, 100);
    items.push(...page.items.filter((endpoint) => endpoint.status !== "DELETED"));
    cursor = page.nextCursor;
  } while (cursor);

  return items;
}

export async function createSandboxWorkspaceFromDemo(name?: string): Promise<SandboxCloneResult> {
  const sourceEndpoints = await listAllDemoEndpoints();
  const organization = await apiClient.createOrganization(buildCloneName(name));

  const cloneResults = await Promise.allSettled(
    sourceEndpoints.map((endpoint) => apiClient.createEndpoint(toClonedEndpointPayload(endpoint, organization.orgId)))
  );

  const failedEndpointNames = cloneResults.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return [];
    }

    const endpoint = sourceEndpoints[index];
    return endpoint ? [endpoint.name] : [];
  });

  return {
    organization,
    sourceEndpointCount: sourceEndpoints.length,
    clonedEndpointCount: cloneResults.length - failedEndpointNames.length,
    failedEndpointNames
  };
}
