import type { CloneDemoOrganizationResult } from "../../../packages/shared/src/types";
import { apiClient } from "./netpulse-client";

export async function createSandboxWorkspaceFromDemo(name?: string): Promise<CloneDemoOrganizationResult> {
  const trimmed = name?.trim();
  return apiClient.cloneDemoOrganization(trimmed || undefined);
}
