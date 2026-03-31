import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput
} from "@aws-sdk/lib-dynamodb";
import { CreateSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  aiInsightsQuerySchema,
  cloneDemoOrganizationSchema,
  createEndpointSchema,
  createOrganizationSchema,
  dashboardSummaryQuerySchema,
  emailChannelSchema,
  endpointSlaQuerySchema,
  failureSimulationSchema,
  incidentListQuerySchema,
  listEndpointsQuerySchema,
  metricsQuerySchema,
  slackChannelSchema,
  updateEndpointSchema,
  upsertMemberSchema,
  webhookChannelSchema,
  websocketSubscriptionSchema,
  type AlertChannel,
  type CloneDemoOrganizationResult,
  type DashboardSummary,
  type Endpoint,
  type FailureClassification,
  type IncidentTimeline,
  type IncidentTimelineEvent,
  type EndpointSlaReport,
  type EndpointMetrics,
  type SimulationRequest,
  type SimulationResponse,
  type SimulationState,
  type AlertEvent,
  type MonitoringRegion,
  type OrgAiInsights,
  type EndpointProtocol,
  type EndpointStatus,
  type Incident,
  type Membership,
  type MetricsWindow,
  type Organization,
  type ProbeResult
} from "@netpulse/shared";
import { buildOrgAiInsights, type EndpointAiSnapshot } from "./ai-insights.js";
import { ddb } from "./db.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { env } from "./env.js";
import { getOrgIdFromEndpointId, makeChannelId, makeEndpointId, makeOrgId } from "./ids.js";

const INCIDENT_GSI = "org-state-index";
const RETENTION_DAYS = 90;
const DEFAULT_REGION: MonitoringRegion = "us-east-1";
const DEFAULT_SLA_TARGET_PCT = 99.9;
const DEFAULT_LATENCY_THRESHOLD_MS = 2000;
const DEFAULT_FAILURE_RATE_THRESHOLD_PCT = 5;
const DEMO_ORG_DEFAULT_NAME = "NetPulse Public Demo";
const DEMO_SANDBOX_NAME_PREFIX = "NetPulse Demo Sandbox";
const BURN_RATE_ALERT_THRESHOLD = 2;
const WINDOW_MINUTES: Record<MetricsWindow, number> = {
  "24h": 24 * 60,
  "7d": 7 * 24 * 60,
  "30d": 30 * 24 * 60
};
const secretsManager = new SecretsManagerClient({});

function parseProtocol(url: string): EndpointProtocol {
  if (url.startsWith("https://")) {
    return "HTTPS";
  }

  if (url.startsWith("http://")) {
    return "HTTP";
  }

  throw new Error("Invalid endpoint protocol: only HTTP/HTTPS are allowed");
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultCloneDemoOrganizationName(fromIso = nowIso()): string {
  const stamp = fromIso.slice(0, 16).replace("T", " ");
  return `${DEMO_SANDBOX_NAME_PREFIX} ${stamp}`;
}

function getRetentionEpoch(fromIso = nowIso()): number {
  const ts = new Date(fromIso).getTime();
  const expiresMs = ts + RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.floor(expiresMs / 1000);
}

function toMonitoringRegion(value: unknown): MonitoringRegion {
  if (
    value === "us-east-1" ||
    value === "us-west-2" ||
    value === "eu-west-1" ||
    value === "ap-southeast-1"
  ) {
    return value;
  }

  return DEFAULT_REGION;
}

function uniqueRegions(regions: MonitoringRegion[] | undefined): MonitoringRegion[] {
  const normalized = (regions ?? [DEFAULT_REGION]).map((region) => toMonitoringRegion(region));
  return [...new Set(normalized)];
}

function normalizeRegionFailures(
  regionFailures: Partial<Record<MonitoringRegion, number>> | undefined
): Partial<Record<MonitoringRegion, number>> {
  if (!regionFailures) {
    return {};
  }

  const normalized: Partial<Record<MonitoringRegion, number>> = {};
  for (const [key, value] of Object.entries(regionFailures)) {
    const region = toMonitoringRegion(key);
    normalized[region] = typeof value === "number" && value > 0 ? value : 0;
  }

  return normalized;
}

function maxFailures(regionFailures: Partial<Record<MonitoringRegion, number>>): number {
  const values = Object.values(regionFailures).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? 0 : Math.max(...values);
}

function normalizeEndpoint(item: Endpoint): Endpoint {
  const checkRegions = uniqueRegions(item.checkRegions);
  const regionFailures = normalizeRegionFailures(item.regionFailures);
  const simulation = item.simulation as SimulationState | undefined;

  return {
    ...item,
    checkRegions,
    regionFailures,
    slaTargetPct:
      typeof item.slaTargetPct === "number" && item.slaTargetPct >= 90 && item.slaTargetPct <= 100
        ? item.slaTargetPct
        : DEFAULT_SLA_TARGET_PCT,
    latencyThresholdMs:
      typeof item.latencyThresholdMs === "number" && item.latencyThresholdMs >= 100
        ? item.latencyThresholdMs
        : DEFAULT_LATENCY_THRESHOLD_MS,
    failureRateThresholdPct:
      typeof item.failureRateThresholdPct === "number" &&
      item.failureRateThresholdPct >= 0 &&
      item.failureRateThresholdPct <= 100
        ? Number(item.failureRateThresholdPct.toFixed(2))
        : DEFAULT_FAILURE_RATE_THRESHOLD_PCT,
    consecutiveFailures:
      typeof item.consecutiveFailures === "number" ? item.consecutiveFailures : maxFailures(regionFailures),
    ...(simulation ? { simulation } : {})
  };
}

function normalizeProbeResult(item: ProbeResult): ProbeResult {
  return {
    ...item,
    region: toMonitoringRegion(item.region)
  };
}

function normalizeIncident(item: Incident): Incident {
  const region = item.region ? toMonitoringRegion(item.region) : undefined;
  return {
    ...item,
    ...(region ? { region } : {})
  };
}

function getSlaStats(uptimePct: number, slaTargetPct: number): {
  slaMet: boolean;
  errorBudgetRemainingPct: number;
} {
  const budgetPct = Math.max(0, 100 - slaTargetPct);
  const consumedPct = Math.max(0, 100 - uptimePct);
  const remainingPct =
    budgetPct === 0 ? (consumedPct === 0 ? 100 : 0) : Math.max(0, ((budgetPct - consumedPct) / budgetPct) * 100);

  return {
    slaMet: uptimePct >= slaTargetPct,
    errorBudgetRemainingPct: Number(remainingPct.toFixed(2))
  };
}

function calculateBurnRate(failureRatePct: number, slaTargetPct: number): number {
  const errorBudgetFraction = Math.max(0, (100 - slaTargetPct) / 100);
  const failureFraction = Math.max(0, failureRatePct / 100);

  if (errorBudgetFraction === 0) {
    return failureFraction > 0 ? 9999 : 0;
  }

  return Number((failureFraction / errorBudgetFraction).toFixed(2));
}

function classifyProbe(item: ProbeResult): FailureClassification {
  if (item.errorType === "SIMULATED_FORCE_FAIL") {
    return "SIMULATED_FORCE_FAIL";
  }

  if (item.errorType === "SIMULATED_FORCE_DEGRADED") {
    return "SIMULATED_FORCE_DEGRADED";
  }

  if (item.errorType === "TIMEOUT") {
    return "TIMEOUT";
  }

  if (item.errorType === "NETWORK") {
    return "NETWORK";
  }

  if (item.errorType === "CIRCUIT_OPEN") {
    return "CIRCUIT_OPEN";
  }

  const statusCode = item.statusCode ?? 0;
  if (statusCode >= 500) {
    return "HTTP_5XX";
  }
  if (statusCode >= 400) {
    return "HTTP_4XX";
  }

  return "HTTP_2XX_3XX";
}

export async function createOrganization(input: unknown, identity: { userId: string; email: string }) {
  const payload = createOrganizationSchema.parse(input);
  const createdAt = nowIso();
  const orgId = makeOrgId();

  const org: Organization = {
    orgId,
    name: payload.name,
    createdAt,
    endpointLimit: env.endpointLimitDefault,
    isActive: true
  };

  const membership: Membership = {
    orgId,
    userId: identity.userId,
    email: identity.email,
    role: "Owner",
    createdAt,
    updatedAt: createdAt,
    isActive: true
  };

  await Promise.all([
    ddb.send(
      new PutCommand({
        TableName: env.organizationsTable,
        Item: org,
        ConditionExpression: "attribute_not_exists(orgId)"
      })
    ),
    ddb.send(
      new PutCommand({
        TableName: env.membershipsTable,
        Item: membership,
        ConditionExpression: "attribute_not_exists(orgId) AND attribute_not_exists(userId)"
      })
    )
  ]);

  return org;
}

export async function getOrganization(orgId: string): Promise<Organization> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.organizationsTable,
      Key: { orgId }
    })
  );

  const item = result.Item as Organization | undefined;

  if (!item) {
    throw new Error("Organization not found");
  }

  return item;
}

export async function ensureOrganization(
  orgId: string,
  options?: { name?: string; isActive?: boolean }
): Promise<Organization> {
  const existing = await ddb.send(
    new GetCommand({
      TableName: env.organizationsTable,
      Key: { orgId }
    })
  );

  const current = existing.Item as Organization | undefined;
  if (current) {
    return current;
  }

  const createdAt = nowIso();
  const organization: Organization = {
    orgId,
    name: options?.name ?? "NetPulse Public Demo",
    createdAt,
    endpointLimit: env.endpointLimitDefault,
    isActive: options?.isActive ?? true
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: env.organizationsTable,
        Item: organization,
        ConditionExpression: "attribute_not_exists(orgId)"
      })
    );
    return organization;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ConditionalCheckFailedException")) {
      return getOrganization(orgId);
    }
    throw error;
  }
}

function toClonedEndpointPayload(endpoint: Endpoint, orgId: string) {
  return {
    orgId,
    name: endpoint.name,
    url: endpoint.url,
    timeoutMs: endpoint.timeoutMs,
    tags: endpoint.tags,
    checkRegions: endpoint.checkRegions,
    slaTargetPct: endpoint.slaTargetPct,
    ...(endpoint.latencyThresholdMs !== undefined ? { latencyThresholdMs: endpoint.latencyThresholdMs } : {}),
    ...(endpoint.failureRateThresholdPct !== undefined
      ? { failureRateThresholdPct: endpoint.failureRateThresholdPct }
      : {})
  };
}

async function listAllEndpointsForOrg(orgId: string): Promise<Endpoint[]> {
  const items: Endpoint[] = [];
  let cursor: string | undefined;

  do {
    const page = await listEndpoints({ orgId, cursor, limit: 100 });
    items.push(...page.items.filter((endpoint) => endpoint.status !== "DELETED"));
    cursor = page.nextCursor;
  } while (cursor);

  return items;
}

export async function cloneDemoOrganization(
  input: unknown,
  identity: { userId: string; email: string }
): Promise<CloneDemoOrganizationResult> {
  if (!env.publicDemoEnabled) {
    throw new Error("Public demo access is disabled");
  }

  const payload = cloneDemoOrganizationSchema.parse(input ?? {});
  const createdAt = nowIso();
  const organization = await createOrganization(
    {
      name: payload.name?.trim() || defaultCloneDemoOrganizationName(createdAt)
    },
    identity
  );

  await ensureOrganization(env.publicDemoOrgId, { name: DEMO_ORG_DEFAULT_NAME, isActive: true });
  const sourceEndpoints = await listAllEndpointsForOrg(env.publicDemoOrgId);
  const cloneResults = await mapWithConcurrency(sourceEndpoints, 8, async (endpoint) => {
    try {
      await createEndpoint(toClonedEndpointPayload(endpoint, organization.orgId));
      return null;
    } catch {
      return endpoint.name;
    }
  });
  const failedEndpointNames = cloneResults.filter((name): name is string => typeof name === "string");

  return {
    organization,
    sourceEndpointCount: sourceEndpoints.length,
    clonedEndpointCount: sourceEndpoints.length - failedEndpointNames.length,
    failedEndpointNames
  };
}

export async function upsertMember(orgId: string, input: unknown): Promise<Membership> {
  const payload = upsertMemberSchema.parse(input);
  const current = nowIso();

  const membership: Membership = {
    orgId,
    userId: payload.userId,
    email: payload.email,
    role: payload.role,
    createdAt: current,
    updatedAt: current,
    isActive: payload.isActive ?? true
  };

  await ddb.send(
    new PutCommand({
      TableName: env.membershipsTable,
      Item: membership
    })
  );

  return membership;
}

export async function joinOrganizationAsViewer(
  orgId: string,
  identity: { userId: string; email: string }
): Promise<Membership> {
  const current = nowIso();
  const output = await ddb.send(
    new UpdateCommand({
      TableName: env.membershipsTable,
      Key: { orgId, userId: identity.userId },
      UpdateExpression:
        "SET #email = :email, #updatedAt = :updatedAt, #isActive = :isActive, #createdAt = if_not_exists(#createdAt, :createdAt), #role = if_not_exists(#role, :role)",
      ExpressionAttributeNames: {
        "#email": "email",
        "#updatedAt": "updatedAt",
        "#isActive": "isActive",
        "#createdAt": "createdAt",
        "#role": "role"
      },
      ExpressionAttributeValues: {
        ":email": identity.email,
        ":updatedAt": current,
        ":isActive": true,
        ":createdAt": current,
        ":role": "Viewer"
      },
      ReturnValues: "ALL_NEW"
    })
  );

  return output.Attributes as Membership;
}

export async function patchMember(
  orgId: string,
  userId: string,
  input: unknown
): Promise<Membership> {
  const parsed = upsertMemberSchema.partial().parse(input);

  if (!parsed.role && parsed.isActive === undefined) {
    throw new Error("No member fields to update");
  }

  const parts: string[] = ["#updatedAt = :updatedAt"];
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":updatedAt": nowIso() };

  if (parsed.role) {
    names["#role"] = "role";
    values[":role"] = parsed.role;
    parts.push("#role = :role");
  }

  if (typeof parsed.isActive === "boolean") {
    names["#isActive"] = "isActive";
    values[":isActive"] = parsed.isActive;
    parts.push("#isActive = :isActive");
  }

  const output = await ddb.send(
    new UpdateCommand({
      TableName: env.membershipsTable,
      Key: { orgId, userId },
      UpdateExpression: `SET ${parts.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(orgId) AND attribute_exists(userId)",
      ReturnValues: "ALL_NEW"
    })
  );

  return output.Attributes as Membership;
}

export async function createEndpoint(input: unknown): Promise<Endpoint> {
  const payload = createEndpointSchema.parse(input);
  const createdAt = nowIso();
  const endpointId = makeEndpointId(payload.orgId);
  const checkRegions = uniqueRegions(payload.checkRegions);

  const endpoint: Endpoint = {
    orgId: payload.orgId,
    endpointId,
    name: payload.name,
    url: payload.url,
    protocol: parseProtocol(payload.url),
    timeoutMs: payload.timeoutMs,
    tags: payload.tags,
    status: "DEGRADED",
    createdAt,
    updatedAt: createdAt,
    paused: false,
    consecutiveFailures: 0,
    checkRegions,
    regionFailures: {},
    slaTargetPct: payload.slaTargetPct,
    latencyThresholdMs: payload.latencyThresholdMs,
    failureRateThresholdPct: payload.failureRateThresholdPct
  };

  await ddb.send(
    new PutCommand({
      TableName: env.endpointsTable,
      Item: {
        ...endpoint,
        statusUpdatedAt: `${endpoint.status}#${endpoint.updatedAt}`
      },
      ConditionExpression: "attribute_not_exists(orgId) AND attribute_not_exists(endpointId)"
    })
  );

  return normalizeEndpoint(endpoint);
}

export async function listEndpoints(params: unknown) {
  const parsed = listEndpointsQuerySchema.parse(params);

  const result = await ddb.send(
    new QueryCommand({
      TableName: env.endpointsTable,
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: {
        ":orgId": parsed.orgId
      },
      Limit: parsed.limit ?? 50,
      ExclusiveStartKey: decodeCursor(parsed.cursor)
    })
  );

  return {
    items: ((result.Items ?? []) as Endpoint[]).map(normalizeEndpoint),
    nextCursor: result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined
  };
}

export async function getEndpoint(endpointId: string): Promise<Endpoint> {
  const orgId = getOrgIdFromEndpointId(endpointId);

  const result = await ddb.send(
    new GetCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId }
    })
  );

  const item = result.Item as Endpoint | undefined;

  if (!item) {
    throw new Error("Endpoint not found");
  }

  return normalizeEndpoint(item);
}

export async function patchEndpoint(endpointId: string, input: unknown): Promise<Endpoint> {
  const parsed = updateEndpointSchema.parse(input);

  if (Object.keys(parsed).length === 0) {
    throw new Error("No endpoint fields to update");
  }

  const orgId = getOrgIdFromEndpointId(endpointId);

  const names: Record<string, string> = {
    "#updatedAt": "updatedAt"
  };
  const values: Record<string, unknown> = {
    ":updatedAt": nowIso()
  };
  const sets: string[] = ["#updatedAt = :updatedAt"];
  let nextStatus: EndpointStatus | undefined;

  const setField = (name: string, value: unknown) => {
    names[`#${name}`] = name;
    values[`:${name}`] = value;
    sets.push(`#${name} = :${name}`);
  };

  if (parsed.name) setField("name", parsed.name);
  if (parsed.url) {
    setField("url", parsed.url);
    setField("protocol", parseProtocol(parsed.url));
  }
  if (typeof parsed.timeoutMs === "number") setField("timeoutMs", parsed.timeoutMs);
  if (parsed.tags) setField("tags", parsed.tags);
  if (parsed.checkRegions) setField("checkRegions", uniqueRegions(parsed.checkRegions));
  if (typeof parsed.slaTargetPct === "number") setField("slaTargetPct", parsed.slaTargetPct);
  if (typeof parsed.latencyThresholdMs === "number") {
    setField("latencyThresholdMs", parsed.latencyThresholdMs);
  }
  if (typeof parsed.failureRateThresholdPct === "number") {
    setField("failureRateThresholdPct", parsed.failureRateThresholdPct);
  }
  if (typeof parsed.paused === "boolean") {
    setField("paused", parsed.paused);
    nextStatus = parsed.paused ? "PAUSED" : "DEGRADED";
    setField("status", nextStatus);
    setField("statusUpdatedAt", `${nextStatus}#${values[":updatedAt"] as string}`);
  }

  const output = await ddb.send(
    new UpdateCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(orgId) AND attribute_exists(endpointId)",
      ReturnValues: "ALL_NEW"
    })
  );

  return normalizeEndpoint(output.Attributes as Endpoint);
}

export async function softDeleteEndpoint(endpointId: string): Promise<void> {
  const orgId = getOrgIdFromEndpointId(endpointId);
  const updatedAt = nowIso();

  await ddb.send(
    new UpdateCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId },
      UpdateExpression:
        "SET #status = :status, #paused = :paused, #updatedAt = :updatedAt, #statusUpdatedAt = :statusUpdatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
        "#paused": "paused",
        "#updatedAt": "updatedAt",
        "#statusUpdatedAt": "statusUpdatedAt"
      },
      ExpressionAttributeValues: {
        ":status": "DELETED",
        ":paused": true,
        ":updatedAt": updatedAt,
        ":statusUpdatedAt": `DELETED#${updatedAt}`
      },
      ConditionExpression: "attribute_exists(orgId) AND attribute_exists(endpointId)"
    })
  );
}

export async function listChecks(
  endpointId: string,
  params: { from: string; to: string; cursor?: string | undefined }
): Promise<{ items: ProbeResult[]; nextCursor?: string }> {
  const orgId = getOrgIdFromEndpointId(endpointId);
  const pk = `${orgId}#${endpointId}`;

  const result = await ddb.send(
    new QueryCommand({
      TableName: env.probeResultsTable,
      KeyConditionExpression: "probePk = :pk AND timestampIso BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":from": params.from,
        ":to": params.to
      },
      ExclusiveStartKey: decodeCursor(params.cursor),
      ScanIndexForward: false,
      Limit: 100
    })
  );

  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;

  return nextCursor
    ? {
        items: ((result.Items ?? []) as ProbeResult[]).map(normalizeProbeResult),
        nextCursor
      }
    : {
        items: ((result.Items ?? []) as ProbeResult[]).map(normalizeProbeResult)
      };
}

function getWindowBounds(window: MetricsWindow): { fromIso: string; toIso: string } {
  const end = new Date();
  const start = new Date(end);

  if (window === "24h") {
    start.setHours(end.getHours() - 24);
  } else if (window === "7d") {
    start.setDate(end.getDate() - 7);
  } else {
    start.setDate(end.getDate() - 30);
  }

  return {
    fromIso: start.toISOString(),
    toIso: end.toISOString()
  };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, idx)] ?? 0;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= items.length) {
        return;
      }

      const item = items[currentIndex];
      if (!item) {
        continue;
      }
      results[currentIndex] = await mapper(item, currentIndex);
    }
  };

  await Promise.all(new Array(boundedConcurrency).fill(undefined).map(() => worker()));
  return results;
}

export async function getMetrics(endpointId: string, windowInput: unknown): Promise<EndpointMetrics> {
  const parsed = metricsQuerySchema.parse(windowInput);
  const window = parsed.window;
  const orgId = getOrgIdFromEndpointId(endpointId);
  const pk = `${orgId}#${endpointId}`;
  const endpoint = await getEndpoint(endpointId);
  const { fromIso, toIso } = getWindowBounds(window);

  const result = await ddb.send(
    new QueryCommand({
      TableName: env.probeResultsTable,
      KeyConditionExpression: "probePk = :pk AND timestampIso BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":from": fromIso,
        ":to": toIso
      },
      Limit: 4000
    })
  );

  const items = ((result.Items ?? []) as ProbeResult[]).map((item) => {
    const normalized = normalizeProbeResult(item);
    return {
      ...normalized,
      classification: normalized.classification ?? classifyProbe(normalized)
    };
  });
  const success = items.filter((item) => item.ok).length;
  const failure = items.length - success;
  const failureRatePct = items.length > 0 ? Number(((failure / items.length) * 100).toFixed(2)) : 0;
  const latencies = items
    .map((item) => item.latencyMs)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  const avgMs =
    latencies.length > 0 ? Number((latencies.reduce((acc, n) => acc + n, 0) / latencies.length).toFixed(2)) : 0;
  const uptimePct = items.length > 0 ? Number(((success / items.length) * 100).toFixed(2)) : 100;
  const slaStats = getSlaStats(uptimePct, endpoint.slaTargetPct);
  const burnRate = calculateBurnRate(failureRatePct, endpoint.slaTargetPct);
  const burnRateAlert = burnRate >= BURN_RATE_ALERT_THRESHOLD;
  const latencyThresholdMs = endpoint.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS;
  const failureRateThresholdPct =
    endpoint.failureRateThresholdPct ?? DEFAULT_FAILURE_RATE_THRESHOLD_PCT;

  const regionStats = new Map<
    MonitoringRegion,
    { checks: number; success: number; latencyTotal: number; latencyCount: number }
  >();

  for (const region of endpoint.checkRegions) {
    regionStats.set(region, { checks: 0, success: 0, latencyTotal: 0, latencyCount: 0 });
  }

  for (const item of items) {
    const region = toMonitoringRegion(item.region);
    const stats = regionStats.get(region) ?? { checks: 0, success: 0, latencyTotal: 0, latencyCount: 0 };
    stats.checks += 1;
    if (item.ok) {
      stats.success += 1;
    }
    if (typeof item.latencyMs === "number") {
      stats.latencyTotal += item.latencyMs;
      stats.latencyCount += 1;
    }
    regionStats.set(region, stats);
  }

  const byRegion = Array.from(regionStats.entries()).map(([region, stats]) => ({
    region,
    checks: stats.checks,
    uptimePct: stats.checks > 0 ? Number(((stats.success / stats.checks) * 100).toFixed(2)) : 100,
    avgLatencyMs:
      stats.latencyCount > 0 ? Number((stats.latencyTotal / stats.latencyCount).toFixed(2)) : 0
  }));

  return {
    endpointId,
    window,
    checks: items.length,
    success,
    failure,
    failureRatePct,
    uptimePct,
    latency: {
      avgMs,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      p99Ms: percentile(latencies, 99)
    },
    slaTargetPct: endpoint.slaTargetPct,
    slaMet: slaStats.slaMet,
    burnRate,
    burnRateAlert,
    latencyThresholdMs,
    latencyThresholdBreached: avgMs > latencyThresholdMs,
    failureRateThresholdPct,
    failureRateThresholdBreached: failureRatePct > failureRateThresholdPct,
    errorBudgetRemainingPct: slaStats.errorBudgetRemainingPct,
    byRegion
  };
}

export async function getEndpointSlaReport(
  endpointId: string,
  windowInput: unknown
): Promise<EndpointSlaReport> {
  const parsed = endpointSlaQuerySchema.parse(windowInput);
  const metrics = await getMetrics(endpointId, parsed);
  const { fromIso, toIso } = getWindowBounds(metrics.window);
  const totalWindowMinutes = WINDOW_MINUTES[metrics.window];
  const errorBudgetMinutes = Number((((100 - metrics.slaTargetPct) / 100) * totalWindowMinutes).toFixed(2));
  const achievedSlaPct = metrics.checks > 0 ? metrics.uptimePct : null;
  const consumedDowntimeMinutes =
    achievedSlaPct === null ? 0 : ((100 - achievedSlaPct) / 100) * totalWindowMinutes;
  const errorBudgetRemainingMinutes = Number(
    Math.max(0, errorBudgetMinutes - consumedDowntimeMinutes).toFixed(2)
  );

  return {
    endpointId: metrics.endpointId,
    window: metrics.window,
    periodStartIso: fromIso,
    periodEndIso: toIso,
    targetSlaPct: metrics.slaTargetPct,
    achievedSlaPct,
    errorBudgetMinutes,
    errorBudgetRemainingMinutes,
    burnRate: metrics.burnRate,
    burnRateAlert: metrics.burnRateAlert,
    totalChecks: metrics.checks,
    failedChecks: metrics.failure
  };
}

export async function listIncidents(params: unknown): Promise<{ items: Incident[]; nextCursor?: string }> {
  const parsed = incidentListQuerySchema.parse(params);

  const base: QueryCommandInput = {
    TableName: env.incidentsTable,
    IndexName: INCIDENT_GSI,
    KeyConditionExpression: "orgId = :orgId",
    ExpressionAttributeValues: {
      ":orgId": parsed.orgId
    },
    ScanIndexForward: false,
    Limit: parsed.limit ?? 50,
    ExclusiveStartKey: decodeCursor(parsed.cursor)
  };

  if (parsed.status === "open") {
    base.KeyConditionExpression = "orgId = :orgId AND begins_with(stateOpenedAt, :state)";
    base.ExpressionAttributeValues = {
      ...base.ExpressionAttributeValues,
      ":state": "OPEN#"
    };
  }

  if (parsed.status === "resolved") {
    base.KeyConditionExpression = "orgId = :orgId AND begins_with(stateOpenedAt, :state)";
    base.ExpressionAttributeValues = {
      ...base.ExpressionAttributeValues,
      ":state": "RESOLVED#"
    };
  }

  const result = await ddb.send(new QueryCommand(base));

  const nextCursor = result.LastEvaluatedKey ? encodeCursor(result.LastEvaluatedKey) : undefined;

  return nextCursor
    ? {
        items: ((result.Items ?? []) as Incident[]).map(normalizeIncident),
        nextCursor
      }
    : {
        items: ((result.Items ?? []) as Incident[]).map(normalizeIncident)
      };
}

async function findIncidentById(incidentId: string): Promise<Incident | null> {
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: env.incidentsTable,
        FilterExpression: "incidentId = :incidentId",
        ExpressionAttributeValues: {
          ":incidentId": incidentId
        },
        ExclusiveStartKey: lastKey,
        Limit: 200
      })
    );

    const found = (page.Items ?? [])[0] as Incident | undefined;
    if (found) {
      return normalizeIncident(found);
    }

    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return null;
}

export async function getIncidentById(incidentId: string): Promise<Incident> {
  const incident = await findIncidentById(incidentId);
  if (!incident) {
    throw new Error("Incident not found");
  }

  return incident;
}

export async function getIncidentTimeline(
  incidentId: string,
  input?: {
    limit?: number | undefined;
  }
): Promise<IncidentTimeline> {
  const incident = await getIncidentById(incidentId);
  const region = incident.region ? toMonitoringRegion(incident.region) : undefined;
  const openedAtTs = Date.parse(incident.openedAt);
  const resolvedAtTs = incident.resolvedAt ? Date.parse(incident.resolvedAt) : Date.now();
  const fromIso = new Date(openedAtTs - 30 * 60 * 1000).toISOString();
  const toIso = new Date(resolvedAtTs + 30 * 60 * 1000).toISOString();
  const probePk = `${incident.orgId}#${incident.endpointId}`;

  const probesResponse = await ddb.send(
    new QueryCommand({
      TableName: env.probeResultsTable,
      KeyConditionExpression: "probePk = :probePk AND timestampIso BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":probePk": probePk,
        ":from": fromIso,
        ":to": toIso
      },
      ScanIndexForward: true,
      Limit: 600
    })
  );

  const probeEvents: IncidentTimelineEvent[] = ((probesResponse.Items ?? []) as ProbeResult[])
    .map(normalizeProbeResult)
    .filter((probe) => (region ? toMonitoringRegion(probe.region) === region : true))
    .map((probe) => {
      const classification = probe.classification ?? classifyProbe(probe);
      const message = probe.ok
        ? `Probe recovered from ${probe.region} (${probe.statusCode ?? 200})`
        : `Probe failed from ${probe.region} (${classification})`;

      return {
        ts: probe.timestampIso,
        type: probe.ok ? "PROBE_RECOVERED" : "PROBE_FAILED",
        message,
        region: toMonitoringRegion(probe.region),
        ...(typeof probe.statusCode === "number" ? { statusCode: probe.statusCode } : {}),
        ...(typeof probe.latencyMs === "number" ? { latencyMs: probe.latencyMs } : {}),
        ...(probe.errorType ? { errorType: probe.errorType } : {})
      };
    });

  const events: IncidentTimelineEvent[] = [
    {
      ts: incident.openedAt,
      type: "INCIDENT_OPENED",
      message: "Incident opened after consecutive failures",
      ...(region ? { region } : {})
    },
    {
      ts: incident.openedAt,
      type: "ALERT_SENT",
      message: "Alert fanout triggered for incident open",
      ...(region ? { region } : {})
    },
    ...probeEvents
  ];

  if (incident.resolvedAt) {
    events.push(
      {
        ts: incident.resolvedAt,
        type: "INCIDENT_RESOLVED",
        message: "Incident resolved on first successful probe",
        ...(region ? { region } : {})
      },
      {
        ts: incident.resolvedAt,
        type: "ALERT_SENT",
        message: "Alert fanout triggered for incident resolve",
        ...(region ? { region } : {})
      }
    );
  }

  const sorted = events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const limit = input?.limit ?? 100;
  const limited = sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;

  return {
    incidentId: incident.incidentId,
    orgId: incident.orgId,
    endpointId: incident.endpointId,
    ...(region ? { region } : {}),
    state: incident.state,
    openedAt: incident.openedAt,
    ...(incident.resolvedAt ? { resolvedAt: incident.resolvedAt } : {}),
    events: limited
  };
}

export async function registerEmailChannel(input: unknown): Promise<AlertChannel> {
  const payload = emailChannelSchema.parse(input);
  const current = nowIso();

  const channel: AlertChannel = {
    orgId: payload.orgId,
    channelId: makeChannelId("email"),
    type: "EMAIL",
    target: payload.email,
    verified: true,
    muted: false,
    createdAt: current,
    updatedAt: current
  };

  await ddb.send(
    new PutCommand({
      TableName: env.alertChannelsTable,
      Item: channel
    })
  );

  return channel;
}

async function createSecretBackedChannel(
  orgId: string,
  channelId: string,
  type: "SLACK" | "WEBHOOK",
  secretValue: string,
  options?: {
    name?: string;
    events?: AlertEvent[];
    secretHeaderName?: string;
  }
): Promise<AlertChannel> {
  const current = nowIso();
  const secretName = `netpulse/${orgId}/${type.toLowerCase()}/${channelId}`;
  const secret = await secretsManager.send(
    new CreateSecretCommand({
      Name: secretName,
      SecretString: secretValue
    })
  );

  if (!secret.ARN) {
    throw new Error(`Failed to create ${type} webhook secret`);
  }

  const channel: AlertChannel = {
    orgId,
    channelId,
    ...(options?.name ? { name: options.name } : {}),
    type,
    target: secret.ARN,
    ...(options?.events ? { events: options.events } : {}),
    ...(options?.secretHeaderName ? { secretHeaderName: options.secretHeaderName } : {}),
    verified: true,
    muted: false,
    createdAt: current,
    updatedAt: current
  };

  await ddb.send(
    new PutCommand({
      TableName: env.alertChannelsTable,
      Item: channel
    })
  );

  return channel;
}

export async function registerSlackChannel(input: unknown): Promise<AlertChannel> {
  const payload = slackChannelSchema.parse(input);
  const channelId = makeChannelId("slack");
  return createSecretBackedChannel(payload.orgId, channelId, "SLACK", payload.webhookUrl);
}

export async function registerWebhookChannel(input: unknown): Promise<AlertChannel> {
  const payload = webhookChannelSchema.parse(input);
  const channelId = makeChannelId("webhook");
  const secretPayload = JSON.stringify({
    url: payload.url,
    ...(payload.secretHeaderName ? { secretHeaderName: payload.secretHeaderName } : {}),
    ...(payload.secretHeaderValue ? { secretHeaderValue: payload.secretHeaderValue } : {})
  });

  return createSecretBackedChannel(payload.orgId, channelId, "WEBHOOK", secretPayload, {
    name: payload.name,
    events: payload.events,
    ...(payload.secretHeaderName ? { secretHeaderName: payload.secretHeaderName } : {})
  });
}

export async function getDashboardSummary(params: unknown): Promise<DashboardSummary> {
  const parsed = dashboardSummaryQuerySchema.parse(params);

  const result = await ddb.send(
    new QueryCommand({
      TableName: env.endpointsTable,
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: {
        ":orgId": parsed.orgId
      }
    })
  );

  const endpoints = ((result.Items ?? []) as Endpoint[]).map(normalizeEndpoint);
  const activeEndpoints = endpoints.filter((item) => item.status !== "DELETED");
  const total = activeEndpoints.length;

  const countStatus = (status: EndpointStatus) => activeEndpoints.filter((item) => item.status === status).length;

  const healthy = countStatus("HEALTHY");
  const degraded = countStatus("DEGRADED");
  const down = countStatus("DOWN");
  const paused = countStatus("PAUSED");
  const defaultUptime = total > 0 ? Number((((healthy + degraded) / total) * 100).toFixed(2)) : 100;
  const averageSlaTargetPct =
    total > 0
      ? Number(
          (
            activeEndpoints.reduce((sum, endpoint) => sum + (endpoint.slaTargetPct ?? DEFAULT_SLA_TARGET_PCT), 0) /
            total
          ).toFixed(2)
        )
      : DEFAULT_SLA_TARGET_PCT;

  const sparklinePoints = parsed.window === "24h" ? 24 : parsed.window === "7d" ? 14 : 30;
  const sparkline: DashboardSummary["sparkline"] = [];
  const burnRateSparkline: DashboardSummary["burnRateSparkline"] = [];
  const { fromIso, toIso } = getWindowBounds(parsed.window);
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  const bucketMs = Math.max(1, Math.floor((toMs - fromMs) / sparklinePoints));
  const bucketChecks = new Array<number>(sparklinePoints).fill(0);
  const bucketFailures = new Array<number>(sparklinePoints).fill(0);
  let totalChecks = 0;
  let totalFailures = 0;

  for (const endpoint of activeEndpoints) {
    const probePk = `${endpoint.orgId}#${endpoint.endpointId}`;
    const page = await ddb.send(
      new QueryCommand({
        TableName: env.probeResultsTable,
        KeyConditionExpression: "probePk = :probePk AND timestampIso BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":probePk": probePk,
          ":from": fromIso,
          ":to": toIso
        },
        Limit: 4000
      })
    );

    for (const item of (page.Items ?? []) as ProbeResult[]) {
      const tsMs = Date.parse(item.timestampIso);
      if (Number.isNaN(tsMs)) {
        continue;
      }

      const rawIndex = Math.floor((tsMs - fromMs) / bucketMs);
      const bucketIndex = Math.max(0, Math.min(sparklinePoints - 1, rawIndex));
      totalChecks += 1;
      bucketChecks[bucketIndex] = (bucketChecks[bucketIndex] ?? 0) + 1;

      if (!item.ok) {
        totalFailures += 1;
        bucketFailures[bucketIndex] = (bucketFailures[bucketIndex] ?? 0) + 1;
      }
    }
  }

  const failureRatePct =
    totalChecks > 0 ? Number(((totalFailures / totalChecks) * 100).toFixed(2)) : Number((100 - defaultUptime).toFixed(2));
  const uptimePct = totalChecks > 0 ? Number((((totalChecks - totalFailures) / totalChecks) * 100).toFixed(2)) : defaultUptime;
  const burnRate = calculateBurnRate(failureRatePct, averageSlaTargetPct);
  const burnRateAlert = burnRate >= BURN_RATE_ALERT_THRESHOLD;

  for (let i = 0; i < sparklinePoints; i += 1) {
    const t = new Date(fromMs + i * bucketMs).toISOString();
    const checks = bucketChecks[i] ?? 0;
    const failures = bucketFailures[i] ?? 0;
    const pointFailureRate = checks > 0 ? (failures / checks) * 100 : failureRatePct;
    const pointUptime = checks > 0 ? ((checks - failures) / checks) * 100 : uptimePct;
    sparkline.push({ t, uptimePct: Number(pointUptime.toFixed(2)) });
    burnRateSparkline.push({
      t,
      burnRate: Number(calculateBurnRate(Number(pointFailureRate.toFixed(2)), averageSlaTargetPct).toFixed(2))
    });
  }

  return {
    orgId: parsed.orgId,
    window: parsed.window,
    totalEndpoints: total,
    healthyEndpoints: healthy,
    degradedEndpoints: degraded,
    downEndpoints: down,
    pausedEndpoints: paused,
    uptimePct,
    failureRatePct,
    burnRate,
    burnRateAlert,
    sparkline,
    burnRateSparkline
  };
}

export async function getOrgAiInsights(params: unknown): Promise<OrgAiInsights> {
  const parsed = aiInsightsQuerySchema.parse(params);
  const { fromIso, toIso } = getWindowBounds(parsed.window);

  const endpointResult = await ddb.send(
    new QueryCommand({
      TableName: env.endpointsTable,
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: {
        ":orgId": parsed.orgId
      }
    })
  );

  const endpoints = ((endpointResult.Items ?? []) as Endpoint[])
    .map(normalizeEndpoint)
    .filter((endpoint) => endpoint.status !== "DELETED");

  const snapshots = await mapWithConcurrency(endpoints, 20, async (endpoint): Promise<EndpointAiSnapshot> => {
    const probePk = `${endpoint.orgId}#${endpoint.endpointId}`;
    const probeResult = await ddb.send(
      new QueryCommand({
        TableName: env.probeResultsTable,
        KeyConditionExpression: "probePk = :probePk AND timestampIso BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":probePk": probePk,
          ":from": fromIso,
          ":to": toIso
        },
        Limit: 4000
      })
    );

    const probes = ((probeResult.Items ?? []) as ProbeResult[]).map(normalizeProbeResult);
    const checks = probes.length;
    const failedChecks = probes.filter((probe) => !probe.ok).length;
    const failureRatePct = checks > 0 ? Number(((failedChecks / checks) * 100).toFixed(2)) : 0;
    const latencies = probes
      .map((probe) => probe.latencyMs)
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => a - b);
    const avgLatencyMs =
      latencies.length > 0 ? Number((latencies.reduce((sum, item) => sum + item, 0) / latencies.length).toFixed(2)) : 0;
    const p95LatencyMs = percentile(latencies, 95);
    const slaTargetPct = endpoint.slaTargetPct ?? DEFAULT_SLA_TARGET_PCT;
    const burnRate = calculateBurnRate(failureRatePct, slaTargetPct);

    return {
      endpointId: endpoint.endpointId,
      endpointName: endpoint.name,
      checks,
      failedChecks,
      failureRatePct,
      burnRate,
      avgLatencyMs,
      p95LatencyMs,
      latencyThresholdMs: endpoint.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS
    };
  });

  return buildOrgAiInsights({
    orgId: parsed.orgId,
    window: parsed.window,
    generatedAt: nowIso(),
    endpoints: snapshots
  });
}

function buildSimulationState(input: SimulationRequest, appliedAtIso: string): SimulationState {
  const expiresAtIso =
    typeof input.durationMinutes === "number"
      ? new Date(Date.parse(appliedAtIso) + input.durationMinutes * 60 * 1000).toISOString()
      : null;

  if (input.mode === "FORCE_FAIL") {
    return {
      mode: "FORCE_FAIL",
      appliedAtIso,
      expiresAtIso,
      failureStatusCode: input.failureStatusCode ?? 503
    };
  }

  return {
    mode: "FORCE_DEGRADED",
    appliedAtIso,
    expiresAtIso,
    forcedLatencyMs: input.forcedLatencyMs ?? 2500
  };
}

async function hasActiveSimulation(orgId: string, endpointId: string): Promise<boolean> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId },
      ProjectionExpression: "#simulation",
      ExpressionAttributeNames: {
        "#simulation": "simulation"
      }
    })
  );

  const item = result.Item as { simulation?: SimulationState } | undefined;
  return Boolean(item?.simulation);
}

function simulationResponse(
  endpointId: string,
  mode: SimulationResponse["mode"],
  appliedAtIso: string,
  expiresAtIso: string | null
): SimulationResponse {
  return {
    endpointId,
    mode,
    appliedAtIso,
    expiresAtIso
  };
}

export async function applyEndpointSimulation(
  endpointId: string,
  input: unknown
): Promise<SimulationResponse> {
  const parsed = failureSimulationSchema.parse(input) as SimulationRequest;
  const orgId = getOrgIdFromEndpointId(endpointId);
  const appliedAtIso = nowIso();

  if (parsed.mode === "CLEAR") {
    if (env.simulationClearStrict) {
      const active = await hasActiveSimulation(orgId, endpointId);
      if (!active) {
        throw new Error("INVALID_SIMULATION_STATE: no active simulation to clear");
      }
    }

    await ddb.send(
      new UpdateCommand({
        TableName: env.endpointsTable,
        Key: { orgId, endpointId },
        UpdateExpression: "SET #updatedAt = :updatedAt REMOVE #simulation",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#simulation": "simulation"
        },
        ExpressionAttributeValues: {
          ":updatedAt": appliedAtIso
        },
        ConditionExpression: "attribute_exists(orgId) AND attribute_exists(endpointId)"
      })
    );

    return simulationResponse(endpointId, "CLEAR", appliedAtIso, null);
  }

  const state = buildSimulationState(parsed, appliedAtIso);

  await ddb.send(
    new UpdateCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId },
      UpdateExpression: "SET #simulation = :simulation, #updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#simulation": "simulation",
        "#updatedAt": "updatedAt"
      },
      ExpressionAttributeValues: {
        ":simulation": state,
        ":updatedAt": appliedAtIso
      },
      ConditionExpression: "attribute_exists(orgId) AND attribute_exists(endpointId)"
    })
  );

  return simulationResponse(endpointId, state.mode, state.appliedAtIso, state.expiresAtIso ?? null);
}

export async function removeConnection(connectionId: string): Promise<void> {
  const found = await ddb.send(
    new ScanCommand({
      TableName: env.wsConnectionsTable,
      FilterExpression: "connectionId = :connectionId",
      ExpressionAttributeValues: {
        ":connectionId": connectionId
      }
    })
  );

  const items = found.Items ?? [];

  await Promise.all(
    items.map((item) =>
      ddb.send(
        new UpdateCommand({
          TableName: env.wsConnectionsTable,
          Key: { orgId: item.orgId, connectionId: item.connectionId },
          UpdateExpression: "SET expiresAt = :expiresAt",
          ExpressionAttributeValues: {
            ":expiresAt": Math.floor(Date.now() / 1000) + 60
          }
        })
      )
    )
  );
}

export async function subscribeConnection(
  connectionId: string,
  payload: unknown,
  ttlSeconds = 60 * 60 * 24
): Promise<void> {
  const parsed = websocketSubscriptionSchema.parse(payload);

  await ddb.send(
    new PutCommand({
      TableName: env.wsConnectionsTable,
      Item: {
        orgId: parsed.orgId,
        connectionId,
        endpointIds: parsed.endpointIds ?? [],
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        updatedAt: nowIso()
      }
    })
  );
}

export async function unsubscribeConnection(connectionId: string, payload: unknown): Promise<void> {
  const parsed = websocketSubscriptionSchema.pick({ orgId: true }).parse(payload);

  await ddb.send(
    new UpdateCommand({
      TableName: env.wsConnectionsTable,
      Key: {
        orgId: parsed.orgId,
        connectionId
      },
      UpdateExpression: "SET endpointIds = :ids, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":ids": [],
        ":updatedAt": nowIso()
      }
    })
  );
}

export function probeRecordTTL(timestampIso: string): number {
  return getRetentionEpoch(timestampIso);
}
