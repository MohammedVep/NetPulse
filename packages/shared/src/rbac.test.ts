import { describe, expect, it } from "vitest";
import { hasPermission } from "./rbac.js";

describe("rbac", () => {
  it("allows owner to manage members", () => {
    expect(hasPermission("Owner", "member:write")).toBe(true);
  });

  it("denies viewer endpoint writes", () => {
    expect(hasPermission("Viewer", "endpoint:write")).toBe(false);
  });
});
