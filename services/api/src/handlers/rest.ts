import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2
} from "aws-lambda";
import { getIdentity, requireRole, enforcePermission } from "@netpulse/authz";
import {
  checksQuerySchema,
  dashboardSummaryQuerySchema,
  endpointSlaQuerySchema,
  failureSimulationSchema,
  incidentListQuerySchema,
  listEndpointsQuerySchema,
  metricsQuerySchema,
  type Permission
} from "@netpulse/shared";
import {
  clearEndpointSimulation,
  createEndpoint,
  createOrganization,
  getDashboardSummary,
  getEndpoint,
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
  setEndpointSimulation,
  softDeleteEndpoint,
  upsertMember
} from "../lib/data-access.js";
import { env } from "../lib/env.js";
import { getOrgIdFromEndpointId } from "../lib/ids.js";
import { fail, getBody, json, noContent } from "../lib/http.js";

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

export async function handler(event: ApiEvent): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;

  try {
    const { path, method, context } = getPathAndMethod(event);

    if (context.isPublic && method !== "GET") {
      return json(405, { code: "ERR_405", message: "Public demo route is read-only", requestId });
    }

    if (method === "POST" && path === "/v1/organizations") {
      const identity = getIdentity(event);
      const organization = await createOrganization(getBody(event.body), identity);
      return json(201, organization);
    }

    const orgMatch = path.match(/^\/v1\/organizations\/([^/]+)$/);
    if (method === "GET" && orgMatch) {
      const orgId = getCapture(orgMatch, 1, "orgId");
      await requireOrgAccess(event, orgId, "org:read", context);
      const organization = await getOrganization(orgId);
      return json(200, organization);
    }

    const memberCreateMatch = path.match(/^\/v1\/organizations\/([^/]+)\/members$/);
    if (method === "POST" && memberCreateMatch) {
      const orgId = getCapture(memberCreateMatch, 1, "orgId");
      await requireOrgAccess(event, orgId, "member:write", context);
      const member = await upsertMember(orgId, getBody(event.body));
      return json(201, member);
    }

    const memberPatchMatch = path.match(/^\/v1\/organizations\/([^/]+)\/members\/([^/]+)$/);
    if (method === "PATCH" && memberPatchMatch) {
      const orgId = getCapture(memberPatchMatch, 1, "orgId");
      const memberId = getCapture(memberPatchMatch, 2, "memberId");
      await requireOrgAccess(event, orgId, "member:write", context);
      const member = await patchMember(orgId, memberId, getBody(event.body));
      return json(200, member);
    }

    if (method === "POST" && path === "/v1/endpoints") {
      const payload = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, payload.orgId, "endpoint:write", context);
      const endpoint = await createEndpoint(payload);
      return json(201, endpoint);
    }

    if (method === "GET" && path === "/v1/endpoints") {
      const query = listEndpointsQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "endpoint:read", context);
      const results = await listEndpoints(query);
      return json(200, results);
    }

    const endpointMatch = path.match(/^\/v1\/endpoints\/([^/]+)$/);
    if (endpointMatch) {
      const endpointId = getCapture(endpointMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);

      if (method === "GET") {
        await requireOrgAccess(event, orgId, "endpoint:read", context);
        const endpoint = await getEndpoint(endpointId);
        return json(200, endpoint);
      }

      if (method === "PATCH") {
        await requireOrgAccess(event, orgId, "endpoint:write", context);
        const endpoint = await patchEndpoint(endpointId, getBody(event.body));
        return json(200, endpoint);
      }

      if (method === "DELETE") {
        await requireOrgAccess(event, orgId, "endpoint:write", context);
        await softDeleteEndpoint(endpointId);
        return noContent();
      }
    }

    const endpointChecksMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/checks$/);
    if (method === "GET" && endpointChecksMatch) {
      const endpointId = getCapture(endpointChecksMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read", context);

      const query = checksQuerySchema.parse(event.queryStringParameters ?? {});
      const checks = await listChecks(endpointId, query);
      return json(200, checks);
    }

    const endpointMetricsMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/metrics$/);
    if (method === "GET" && endpointMetricsMatch) {
      const endpointId = getCapture(endpointMetricsMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read", context);

      const query = metricsQuerySchema.parse(event.queryStringParameters ?? {});
      const metrics = await getMetrics(endpointId, query);
      return json(200, metrics);
    }

    const endpointSlaMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/sla$/);
    if (method === "GET" && endpointSlaMatch) {
      const endpointId = getCapture(endpointSlaMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read", context);

      const query = endpointSlaQuerySchema.parse(event.queryStringParameters ?? {});
      const report = await getEndpointSlaReport(endpointId, query);
      return json(200, report);
    }

    const endpointSimulationMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/simulate$/);
    if (endpointSimulationMatch) {
      const endpointId = getCapture(endpointSimulationMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:write", context);

      if (method === "POST") {
        const simulation = failureSimulationSchema.parse(getBody(event.body));
        const endpoint = await setEndpointSimulation(endpointId, simulation);
        return json(200, endpoint);
      }

      if (method === "DELETE") {
        const endpoint = await clearEndpointSimulation(endpointId);
        return json(200, endpoint);
      }
    }

    if (method === "GET" && path === "/v1/incidents") {
      const query = incidentListQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "incident:read", context);
      const incidents = await listIncidents(query);
      return json(200, incidents);
    }

    if (method === "POST" && path === "/v1/alert-channels/email") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write", context);
      const channel = await registerEmailChannel(body);
      return json(201, channel);
    }

    if (method === "POST" && path === "/v1/alert-channels/slack") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write", context);
      const channel = await registerSlackChannel(body);
      return json(201, channel);
    }

    if (method === "POST" && path === "/v1/alert-channels/webhook") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write", context);
      const channel = await registerWebhookChannel(body);
      return json(201, channel);
    }

    if (method === "GET" && path === "/v1/dashboard/summary") {
      const query = dashboardSummaryQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "dashboard:read", context);
      const summary = await getDashboardSummary(query);
      return json(200, summary);
    }

    return json(404, { code: "ERR_404", message: "Route not found", requestId });
  } catch (error) {
    return fail(error, requestId);
  }
}
