import type { Role } from "./types.js";

export type Permission =
  | "org:read"
  | "org:write"
  | "member:read"
  | "member:write"
  | "endpoint:read"
  | "endpoint:write"
  | "incident:read"
  | "incident:write"
  | "channel:read"
  | "channel:write"
  | "dashboard:read";

const permissionMap: Record<Role, Set<Permission>> = {
  Owner: new Set([
    "org:read",
    "org:write",
    "member:read",
    "member:write",
    "endpoint:read",
    "endpoint:write",
    "incident:read",
    "incident:write",
    "channel:read",
    "channel:write",
    "dashboard:read"
  ]),
  Admin: new Set([
    "org:read",
    "member:read",
    "endpoint:read",
    "endpoint:write",
    "incident:read",
    "incident:write",
    "channel:read",
    "channel:write",
    "dashboard:read"
  ]),
  Editor: new Set([
    "org:read",
    "endpoint:read",
    "endpoint:write",
    "incident:read",
    "incident:write",
    "channel:read",
    "channel:write",
    "dashboard:read"
  ]),
  Viewer: new Set(["org:read", "endpoint:read", "incident:read", "dashboard:read", "channel:read"])
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return permissionMap[role].has(permission);
}

export function assertPermission(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Role ${role} lacks permission ${permission}`);
  }
}
