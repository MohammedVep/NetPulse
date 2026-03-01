import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

export interface IdentityContext {
  userId: string;
  email: string;
}

export function getIdentity(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): IdentityContext {
  const claims = event.requestContext.authorizer?.jwt?.claims;

  const userId = claims?.sub;
  const email = claims?.email;
  const normalizedUserId = typeof userId === "string" ? userId : undefined;
  const normalizedEmail = typeof email === "string" ? email : undefined;

  if (!normalizedUserId || !normalizedEmail) {
    throw new Error("Missing authenticated identity claims");
  }

  return {
    userId: normalizedUserId,
    email: normalizedEmail
  };
}
