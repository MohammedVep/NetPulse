import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { websocketSubscriptionSchema } from "@netpulse/shared";
import { requireRole, enforcePermission } from "@netpulse/authz";
import { removeConnection, subscribeConnection, unsubscribeConnection } from "../lib/data-access.js";

const userPoolId = process.env.COGNITO_USER_POOL_ID;
const userPoolClientId = process.env.COGNITO_USER_POOL_CLIENT_ID;

const idTokenVerifier =
  userPoolId && userPoolClientId
    ? CognitoJwtVerifier.create({
        userPoolId,
        tokenUse: "id",
        clientId: userPoolClientId
      })
    : null;

const accessTokenVerifier =
  userPoolId && userPoolClientId
    ? CognitoJwtVerifier.create({
        userPoolId,
        tokenUse: "access",
        clientId: userPoolClientId
      })
    : null;

function ok(statusCode = 200): APIGatewayProxyResultV2 {
  return { statusCode, body: "ok" };
}

function bad(message: string, statusCode = 400): APIGatewayProxyResultV2 {
  return {
    statusCode,
    body: JSON.stringify({ message })
  };
}

function normalizeToken(rawToken?: string): string | undefined {
  if (!rawToken) return undefined;
  return rawToken.replace(/^Bearer\s+/i, "").trim();
}

const publicDemoEnabled = process.env.PUBLIC_DEMO_ENABLED === "true";
const publicDemoOrgId = process.env.PUBLIC_DEMO_ORG_ID ?? "org_demo_public";

function isPublicDemoOrg(orgId: string): boolean {
  return publicDemoEnabled && orgId === publicDemoOrgId;
}

async function verifyCognitoToken(rawToken?: string): Promise<string | undefined> {
  const token = normalizeToken(rawToken);

  if (!token || !idTokenVerifier || !accessTokenVerifier) {
    return undefined;
  }

  try {
    const claims = await idTokenVerifier.verify(token);
    return claims.sub;
  } catch {
    const claims = await accessTokenVerifier.verify(token);
    return claims.sub;
  }
}

export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const connectionId = event.requestContext.connectionId;

    if (event.requestContext.eventType === "DISCONNECT") {
      await removeConnection(connectionId);
      return ok(200);
    }

    if (event.requestContext.eventType !== "MESSAGE") {
      return ok(200);
    }

    const routeKey = event.requestContext.routeKey;

    if (!event.body) {
      return bad("Missing request body");
    }

    const payload = websocketSubscriptionSchema.parse(JSON.parse(event.body));
    const requestContext = event.requestContext as typeof event.requestContext & {
      authorizer?: { jwt?: { claims?: Record<string, string> } };
    };
    const claims = requestContext.authorizer?.jwt?.claims;
    const claimUserId = claims?.sub;
    const tokenUserId = await verifyCognitoToken(payload.token);
    const userId = claimUserId ?? tokenUserId;

    if (!userId) {
      if (process.env.ALLOW_UNAUTHENTICATED_WS !== "true") {
        return bad("Missing authenticated identity claims", 401);
      }
      if (!isPublicDemoOrg(payload.orgId)) {
        return bad("Unauthenticated websocket access is limited to public demo organization data", 403);
      }
    } else {
      if (!isPublicDemoOrg(payload.orgId)) {
        const role = await requireRole(payload.orgId, userId);
        enforcePermission(role, "dashboard:read");
      }
    }

    if (routeKey === "subscribe") {
      await subscribeConnection(connectionId, payload);
      return ok();
    }

    if (routeKey === "unsubscribe") {
      await unsubscribeConnection(connectionId, payload);
      return ok();
    }

    return bad("Unsupported WebSocket route", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return bad(message, 400);
  }
}
