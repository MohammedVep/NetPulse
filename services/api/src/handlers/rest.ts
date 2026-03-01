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
import { getOrgIdFromEndpointId } from "../lib/ids.js";
import { fail, getBody, json, noContent } from "../lib/http.js";

type AuthEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

async function requireOrgAccess(event: AuthEvent, orgId: string, permission: Permission) {
  const identity = getIdentity(event);
  const role = await requireRole(orgId, identity.userId);
  enforcePermission(role, permission);
  return { identity, role };
}

function getPathAndMethod(event: AuthEvent): { path: string; method: string } {
  return {
    path: event.rawPath,
    method: event.requestContext.http.method.toUpperCase()
  };
}

function getCapture(match: RegExpMatchArray, index: number, name: string): string {
  const value = match[index];
  if (!value) {
    throw new Error(`Missing path parameter: ${name}`);
  }

  return decodeURIComponent(value);
}

export async function handler(event: AuthEvent): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;

  try {
    const { path, method } = getPathAndMethod(event);

    if (method === "POST" && path === "/v1/organizations") {
      const identity = getIdentity(event);
      const organization = await createOrganization(getBody(event.body), identity);
      return json(201, organization);
    }

    const orgMatch = path.match(/^\/v1\/organizations\/([^/]+)$/);
    if (method === "GET" && orgMatch) {
      const orgId = getCapture(orgMatch, 1, "orgId");
      await requireOrgAccess(event, orgId, "org:read");
      const organization = await getOrganization(orgId);
      return json(200, organization);
    }

    const memberCreateMatch = path.match(/^\/v1\/organizations\/([^/]+)\/members$/);
    if (method === "POST" && memberCreateMatch) {
      const orgId = getCapture(memberCreateMatch, 1, "orgId");
      await requireOrgAccess(event, orgId, "member:write");
      const member = await upsertMember(orgId, getBody(event.body));
      return json(201, member);
    }

    const memberPatchMatch = path.match(/^\/v1\/organizations\/([^/]+)\/members\/([^/]+)$/);
    if (method === "PATCH" && memberPatchMatch) {
      const orgId = getCapture(memberPatchMatch, 1, "orgId");
      const memberId = getCapture(memberPatchMatch, 2, "memberId");
      await requireOrgAccess(event, orgId, "member:write");
      const member = await patchMember(orgId, memberId, getBody(event.body));
      return json(200, member);
    }

    if (method === "POST" && path === "/v1/endpoints") {
      const payload = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, payload.orgId, "endpoint:write");
      const endpoint = await createEndpoint(payload);
      return json(201, endpoint);
    }

    if (method === "GET" && path === "/v1/endpoints") {
      const query = listEndpointsQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "endpoint:read");
      const results = await listEndpoints(query);
      return json(200, results);
    }

    const endpointMatch = path.match(/^\/v1\/endpoints\/([^/]+)$/);
    if (endpointMatch) {
      const endpointId = getCapture(endpointMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);

      if (method === "GET") {
        await requireOrgAccess(event, orgId, "endpoint:read");
        const endpoint = await getEndpoint(endpointId);
        return json(200, endpoint);
      }

      if (method === "PATCH") {
        await requireOrgAccess(event, orgId, "endpoint:write");
        const endpoint = await patchEndpoint(endpointId, getBody(event.body));
        return json(200, endpoint);
      }

      if (method === "DELETE") {
        await requireOrgAccess(event, orgId, "endpoint:write");
        await softDeleteEndpoint(endpointId);
        return noContent();
      }
    }

    const endpointChecksMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/checks$/);
    if (method === "GET" && endpointChecksMatch) {
      const endpointId = getCapture(endpointChecksMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read");

      const query = checksQuerySchema.parse(event.queryStringParameters ?? {});
      const checks = await listChecks(endpointId, query);
      return json(200, checks);
    }

    const endpointMetricsMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/metrics$/);
    if (method === "GET" && endpointMetricsMatch) {
      const endpointId = getCapture(endpointMetricsMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read");

      const query = metricsQuerySchema.parse(event.queryStringParameters ?? {});
      const metrics = await getMetrics(endpointId, query);
      return json(200, metrics);
    }

    const endpointSlaMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/sla$/);
    if (method === "GET" && endpointSlaMatch) {
      const endpointId = getCapture(endpointSlaMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:read");

      const query = endpointSlaQuerySchema.parse(event.queryStringParameters ?? {});
      const report = await getEndpointSlaReport(endpointId, query);
      return json(200, report);
    }

    const endpointSimulationMatch = path.match(/^\/v1\/endpoints\/([^/]+)\/simulate$/);
    if (endpointSimulationMatch) {
      const endpointId = getCapture(endpointSimulationMatch, 1, "endpointId");
      const orgId = getOrgIdFromEndpointId(endpointId);
      await requireOrgAccess(event, orgId, "endpoint:write");

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
      await requireOrgAccess(event, query.orgId, "incident:read");
      const incidents = await listIncidents(query);
      return json(200, incidents);
    }

    if (method === "POST" && path === "/v1/alert-channels/email") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write");
      const channel = await registerEmailChannel(body);
      return json(201, channel);
    }

    if (method === "POST" && path === "/v1/alert-channels/slack") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write");
      const channel = await registerSlackChannel(body);
      return json(201, channel);
    }

    if (method === "POST" && path === "/v1/alert-channels/webhook") {
      const body = getBody<{ orgId: string }>(event.body);
      await requireOrgAccess(event, body.orgId, "channel:write");
      const channel = await registerWebhookChannel(body);
      return json(201, channel);
    }

    if (method === "GET" && path === "/v1/dashboard/summary") {
      const query = dashboardSummaryQuerySchema.parse(event.queryStringParameters ?? {});
      await requireOrgAccess(event, query.orgId, "dashboard:read");
      const summary = await getDashboardSummary(query);
      return json(200, summary);
    }

    return json(404, { code: "ERR_404", message: "Route not found", requestId });
  } catch (error) {
    return fail(error, requestId);
  }
}
