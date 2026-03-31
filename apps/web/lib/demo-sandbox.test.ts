import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxWorkspaceFromDemo } from "./demo-sandbox";
import { apiClient } from "./netpulse-client";

vi.mock("./netpulse-client", () => ({
  apiClient: {
    cloneDemoOrganization: vi.fn()
  }
}));

describe("createSandboxWorkspaceFromDemo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes a trimmed workspace name to the backend clone API", async () => {
    vi.mocked(apiClient.cloneDemoOrganization).mockResolvedValue({
      organization: {
        orgId: "org_test",
        name: "Sandbox",
        createdAt: "2026-03-30T00:00:00.000Z",
        endpointLimit: 2000,
        isActive: true
      },
      sourceEndpointCount: 2,
      clonedEndpointCount: 2,
      failedEndpointNames: []
    });

    await createSandboxWorkspaceFromDemo("  Sandbox  ");

    expect(apiClient.cloneDemoOrganization).toHaveBeenCalledWith("Sandbox");
  });

  it("lets the backend generate the default sandbox name when none is supplied", async () => {
    vi.mocked(apiClient.cloneDemoOrganization).mockResolvedValue({
      organization: {
        orgId: "org_test",
        name: "NetPulse Demo Sandbox 2026-03-30 00:00",
        createdAt: "2026-03-30T00:00:00.000Z",
        endpointLimit: 2000,
        isActive: true
      },
      sourceEndpointCount: 2,
      clonedEndpointCount: 2,
      failedEndpointNames: []
    });

    await createSandboxWorkspaceFromDemo("   ");

    expect(apiClient.cloneDemoOrganization).toHaveBeenCalledWith(undefined);
  });
});
