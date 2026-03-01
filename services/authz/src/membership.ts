import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Membership, Role } from "@netpulse/shared";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE ?? "np_memberships";

export async function getMembership(orgId: string, userId: string): Promise<Membership | null> {
  const response = await client.send(
    new GetCommand({
      TableName: MEMBERSHIPS_TABLE,
      Key: { orgId, userId }
    })
  );

  return (response.Item as Membership | undefined) ?? null;
}

export async function requireRole(orgId: string, userId: string): Promise<Role> {
  const membership = await getMembership(orgId, userId);

  if (!membership || !membership.isActive) {
    throw new Error("User is not an active org member");
  }

  return membership.role;
}
