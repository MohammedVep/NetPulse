import { assertPermission, type Permission, type Role } from "@netpulse/shared";

export function enforcePermission(role: Role, permission: Permission): void {
  assertPermission(role, permission);
}
