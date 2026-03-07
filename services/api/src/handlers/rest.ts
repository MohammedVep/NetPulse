import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2
} from "aws-lambda";
import { getIdentity, requireRole, enforcePermission } from "@netpulse/authz";
import {
  aiInsightsQuerySchema,
  checksQuerySchema,
  dashboardSummaryQuerySchema,
  endpointSlaQuerySchema,
  failureSimulationSchema,
  incidentTimelineQuerySchema,
  incidentListQuerySchema,
  listEndpointsQuerySchema,
  metricsQuerySchema,
  type Permission
} from "@netpulse/shared";
import {
  applyEndpointSimulation,
  createEndpoint,
  createOrganization,
  getDashboardSummary,
  getOrgAiInsights,
  getEndpoint,
  getIncidentById,
  getIncidentTimeline,
  getEndpointSlaReport,
  getMetrics,
  getOrganization,
  listChecks,
  listEndpoints,
  listIncidents,
  patchEndpoint,
  patchMember,
  registerEmailChannel,
  registerSlackChannel,
  registerWebhookChannel,
  softDeleteEndpoint,
  upsertMember
} from "../lib/data-access.js";
import { env } from "../lib/env.js";
import { getOrgIdFromEndpointId } from "../lib/ids.js";
import { fail, getBody, json, noContent } from "../lib/http.js";
import { correlationIdForEvent, logError, logInfo } from "../lib/observability.js";
import { enforceRateLimit } from "../lib/rate-limit.js";

type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

interface RouteContext {
  isPublic: boolean;
}

const PUBLIC_PREFIX = "/v1/public";
const PUBLIC_READ_PERMISSIONS = new Set<Permission>([
  "org:read",
  "endpoint:read",
  "incident:read",
  "dashboard:read"
]);

function assertPublicAccess(orgId: string, permission: Permission) {
  if (!env.publicDemoEnabled) {
    throw new Error("Public demo access is disabled");
  }

  if (orgId !== env.publicDemoOrgId) {
    throw new Error("Public demo access is limited to demo organization data");
  }

  if (!PUBLIC_READ_PERMISSIONS.has(permission)) {
    throw new Error(`Public demo access lacks permission ${permission}`);
  }
}

async function requireOrgAccess(
  event: ApiEvent,
  orgId: string,
  permission: Permission,
  context: RouteContext
) {
  if (context.isPublic) {
    assertPublicAccess(orgId, permission);
    return;
  }

  const identity = getIdentity(event);
  const role = await requireRole(orgId, identity.userId);
  enforcePermission(role, permission);
}

function getPathAndMethod(event: ApiEvent): { path: string; method: string; context: RouteContext } {
  const rawPath = event.rawPath;
  const method = event.requestContext.http.method.toUpperCase();

  if (rawPath === PUBLIC_PREFIX) {
    return {
      path: "/v1",
      method,
      context: { isPublic: true }
    };
  }

  if (rawPath.startsWith(`${PUBLIC_PREFIX}/`)) {
    return {
      path: `/v1/${rawPath.slice(`${PUBLIC_PREFIX}/`.length)}`,
      method,
      context: { isPublic: true }
    };
  }

  return {
    path: rawPath,
    method,
    context: { isPublic: false }
  };
}

function getCapture(match: RegExpMatchArray, index: number, name: string): string {
  const value = match[index];
  if (!value) {
    throw new Error(`Missing path parameter: ${name}`);
  }

  return decodeURIComponent(value);
}

function safeIdentityUserId(event: ApiEvent): string | null {
  try {
    return getIdentity(event).userId;
  } catch {
    return null;
  }
}

export async function handler(event: ApiEvent): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  const correlationId = correlationIdForEvent(event);
  const startedAt = Date.now();
  const sourceIp = event.requestContext.http.sourceIp ?? "unknown";
  const responseHeaders = {
    "x-request-id": requestId,
    "x-correlation-id": correlationId
  };

  const complete = (statusCode: number) => {
    logInfo("api_request_completed", {
      requestId,
      correlationId,
      method: event.requestContext.http.method.toUpperCase(),
      rawPath: event.rawPath,
      statusCode,
      durationMs: Date.now() - startedAt
    });
  };

  const respondJson = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => {
    complete(statusCode);
    return json(statusCode, body, responseHeaders);
  };

  const respondNoContent = (): APIGatewayProxyResultV2 => {
    complete(204);
    return noContent(responseHeaders);
  };

  try {
    const { path, method, context } = getPathAndMethod(event);
    const identityUserId = safeIdentityUserId(event);
    const requester = context.isPublic
      ? `ip:${sourceIp}`
      : (identityUserId ? `user:${identityUserId}` : `ip:${sourceIp}`);
    const maxRequests = context.isPublic ? env.rateLimitPublicRpm : env.rateLimitAuthRpm;

    await enforceRateLimit({
      key: `rest:${context.isPublic ? "public" : "auth"}:${method}:${requester}`,
      maxRequests
    });

    logInfo("api_request_received", {
      requestId,
      correlationId,
      method,
      path,
      rawPath: event.rawPath,
      sourceIp,
      requester,
      isPublic: context.isPublic
    });

    if (context.isPublic && method !== "GET") {
      return respondJson(405, { code: "ERR_405", message: "Public demo route is read-only", requestId });
    }

    if (method === "POST" && path === "/v1/organizations") {
      const identity = getIdentity(event);
      const organization = await createOrganization(getBody(event.body), identity);
      return respondJson(201, organization);
    }

    const orgMatch = path.match(/^\/v1\/organizations\/([^/]+)$/);
    if (method === "GET" && orgMatch) {
      const orgId = getCapture(orgMatch, 1, "orgId");
      await requireOrgAccess(event, orgId, "org:read", context);
      const organization = await getOrganization(orgId);
      return respondJson(200, organization);
    }

    const memberCreateMatch = path.match(/^\/v1\/organizations\/([^/]+)\/members$/);
    if (method === "POST" && memberCreateMatch) {
      const orgId = getCapture(memberCreateMatch, 1, "orgId");
      await requireOrgAccess(event, orgId, "member:write", context);
      const member = await upsertMember(orgId, getBody(event.body));
      return respondJson(201, member);
    }

    const memberPatchMatch = path.match(/^\/v1\/organizations\/([^/]+)\/members\/([^/]+)$/);
    if (method === "PATCH" && memberPatchMatch) {
      const orgId = getCapture(memberPatchMatch, 1, "orgId");
      const memberId = getCapture(memberPatchMatch, 2, "memberId");
      await requireOrgAccess(event, orgId, "member:write", context);
      const member = await patchMember(orgId, memberId, getBody(event.body));
      return respondJson(200, member);
    }

    if (method === "POST" && path === "/v1/endpoints") {
      const payload = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, payload.orgId, "endpoint:write", context);
      const endpoint = await createEndpoint(payload);
      return respondJson(201, endpoint);
    }

    if (method === "GET" && path === "/v1/endpoints") {
      const query = listEndpointsQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "endpoint:read", context);
      const results = await listEndpoints(query);
      return respondJson(200, results);
    }

    const endpointMatch = path.match(/^\/v1\/endpoints\/([^/]+)$/);
    if (endpointMatch) {
      const endpointId = getCapture(endpointMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);

      if (method === "GET") {
        await requireOrgAccess(event, orgId, "endpoint:read", context);
        const endpoint = await getEndpoint(endpointId);
        return respondJson(200, endpoint);
      }

      if (method === "PATCH") {
        await requireOrgAccess(event, orgId, "endpoint:write", context);
        const endpoint = await patchEndpoint(endpointId, getBody(event.body));
        return respondJson(200, endpoint);
      }

      if (method === "DELETE") {
        await requireOrgAccess(event, orgId, "endpoint:write", context);
        await softDeleteEndpoint(endpointId);
        return respondNoContent();
      }
    }

    const endpointChecksMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/checks$/);
    if (method === "GET" && endpointChecksMatch) {
      const endpointId = getCapture(endpointChecksMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read", context);

      const query = checksQuerySchema.parse(event.queryStringParameters ?? {});
      const checks = await listChecks(endpointId, query);
      return respondJson(200, checks);
    }

    const endpointMetricsMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/metrics$/);
    if (method === "GET" && endpointMetricsMatch) {
      const endpointId = getCapture(endpointMetricsMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read", context);

      const query = metricsQuerySchema.parse(event.queryStringParameters ?? {});
      const metrics = await getMetrics(endpointId, query);
      return respondJson(200, metrics);
    }

    const endpointSlaMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/sla$/);
    if (method === "GET" && endpointSlaMatch) {
      const endpointId = getCapture(endpointSlaMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read", context);

      const query = endpointSlaQuerySchema.parse(event.queryStringParameters ?? {});
      const report = await getEndpointSlaReport(endpointId, query);
      return respondJson(200, report);
    }

    const endpointSimulationMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/simulate$/);
    if (endpointSimulationMatch) {
      const endpointId = getCapture(endpointSimulationMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:write", context);

      if (method === "POST") {
        const simulation = failureSimulationSchema.parse(getBody(event.body));
        const simulationState = await applyEndpointSimulation(endpointId, simulation);
        return respondJson(200, simulationState);
      }

      if (method === "DELETE") {
        const simulationState = await applyEndpointSimulation(endpointId, { mode: "CLEAR" });
        return respondJson(200, simulationState);
      }
    }

    if (method === "GET" && path === "/v1/incidents") {
      const query = incidentListQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "incident:read", context);
      const incidents = await listIncidents(query);
      return respondJson(200, incidents);
    }

    const incidentTimelineMatch = path.match(/^\/v1\/incidents\/([^/]+)\/timeline$/);
    if (method === "GET" && incidentTimelineMatch) {
      const incidentId = getCapture(incidentTimelineMatch, 1, "incidentId");
      const incident = await getIncidentById(incidentId);
      await requireOrgAccess(event, incident.orgId, "incident:read", context);
      const query = incidentTimelineQuerySchema.parse(event.queryStringParameters ?? {});
      const timeline = await getIncidentTimeline(incidentId, query);
      return respondJson(200, timeline);
    }

    if (method === "POST" && path === "/v1/alert-channels/email") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write", context);
      const channel = await registerEmailChannel(body);
      return respondJson(201, channel);
    }

    if (method === "POST" && path === "/v1/alert-channels/slack") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write", context);
      const channel = await registerSlackChannel(body);
      return respondJson(201, channel);
    }

    if (method === "POST" && path === "/v1/alert-channels/webhook") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write", context);
      const channel = await registerWebhookChannel(body);
      return respondJson(201, channel);
    }

    if (method === "GET" && path === "/v1/dashboard/summary") {
      const query = dashboardSummaryQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "dashboard:read", context);
      const summary = await getDashboardSummary(query);
      return respondJson(200, summary);
    }

    if (method === "GET" && path === "/v1/ai/insights") {
      const query = aiInsightsQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "dashboard:read", context);
      const insights = await getOrgAiInsights(query);
      return respondJson(200, insights);
    }

    return respondJson(404, { code: "ERR_404", message: "Route not found", requestId });
  } catch (error) {
    logError("api_request_failed", {
      requestId,
      correlationId,
      method: event.requestContext.http.method.toUpperCase(),
      rawPath: event.rawPath,
      sourceIp,
      error: error instanceof Error ? error.message : String(error)
    });
    const failed = fail(error, { requestId, correlationId });
    complete(failed.statusCode ?? 500);
    return failed;
  }
}
