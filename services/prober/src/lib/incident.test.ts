import { describe, expect, it } from "vitest";
import {
  nextConsecutiveFailures,
  nextEndpointStatus,
  shouldOpenIncident,
  shouldResolveIncident
} from "./incident.js";

describe("incident helpers", () => {
  it("resets consecutive failures on success", () => {
    expect(nextConsecutiveFailures(3, true)).toBe(0);
  });

  it("opens incident on second failure", () => {
    expect(shouldOpenIncident(2)).toBe(true);
    expect(shouldOpenIncident(1)).toBe(false);
  });

  it("resolves only when success arrives for an open incident", () => {
    expect(shouldResolveIncident(true, true)).toBe(true);
    expect(shouldResolveIncident(false, true)).toBe(false);
    expect(shouldResolveIncident(true, false)).toBe(false);
  });

  it("maps status from probe result", () => {
    expect(nextEndpointStatus(true)).toBe("HEALTHY");
    expect(nextEndpointStatus(false)).toBe("DOWN");
  });
});
