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
  type DashboardSummary,
  type Endpoint,
  type EndpointSlaReport,
  type EndpointMetrics,
  type FailureSimulation,
  type MonitoringRegion,
  type EndpointProtocol,
  type EndpointStatus,
  type Incident,
  type Membership,
  type MetricsWindow,
  type Organization,
  type ProbeResult
} from "@netpulse/shared";
import { ddb } from "./db.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { env } from "./env.js";
import { getOrgIdFromEndpointId, makeChannelId, makeEndpointId, makeOrgId } from "./ids.js";

const INCIDENT_GSI = "org-state-index";
const RETENTION_DAYS = 90;
const DEFAULT_REGION: MonitoringRegion = "us-east-1";
const DEFAULT_SLA_TARGET_PCT = 99.9;
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
  const simulation = item.simulation as FailureSimulation | undefined;

  return {
    ...item,
    checkRegions,
    regionFailures,
    slaTargetPct:
      typeof item.slaTargetPct === "number" && item.slaTargetPct >= 90 && item.slaTargetPct <= 100
        ? item.slaTargetPct
        : DEFAULT_SLA_TARGET_PCT,
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
    slaTargetPct: payload.slaTargetPct
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

function getWindowStart(window: MetricsWindow): string {
  const now = new Date();
  const value = new Date(now);

  if (window === "24h") {
    value.setHours(now.getHours() - 24);
  } else if (window === "7d") {
    value.setDate(now.getDate() - 7);
  } else {
    value.setDate(now.getDate() - 30);
  }

  return value.toISOString();
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, idx)] ?? 0;
}

export async function getMetrics(endpointId: string, windowInput: unknown): Promise<EndpointMetrics> {
  const parsed = metricsQuerySchema.parse(windowInput);
  const window = parsed.window;
  const orgId = getOrgIdFromEndpointId(endpointId);
  const pk = `${orgId}#${endpointId}`;
  const endpoint = await getEndpoint(endpointId);

  const result = await ddb.send(
    new QueryCommand({
      TableName: env.probeResultsTable,
      KeyConditionExpression: "probePk = :pk AND timestampIso BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":from": getWindowStart(window),
        ":to": nowIso()
      },
      Limit: 4000
    })
  );

  const items = ((result.Items ?? []) as ProbeResult[]).map(normalizeProbeResult);
  const success = items.filter((item) => item.ok).length;
  const failure = items.length - success;
  const latencies = items
    .map((item) => item.latencyMs)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  const avgMs =
    latencies.length > 0 ? Number((latencies.reduce((acc, n) => acc + n, 0) / latencies.length).toFixed(2)) : 0;
  const uptimePct = items.length > 0 ? Number(((success / items.length) * 100).toFixed(2)) : 100;
  const slaStats = getSlaStats(uptimePct, endpoint.slaTargetPct);

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
    uptimePct,
    latency: {
      avgMs,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95)
    },
    slaTargetPct: endpoint.slaTargetPct,
    slaMet: slaStats.slaMet,
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
  const totalWindowMinutes = WINDOW_MINUTES[metrics.window];
  const allowedDowntimeMinutes = ((100 - metrics.slaTargetPct) / 100) * totalWindowMinutes;
  const consumedDowntimeMinutes = ((100 - metrics.uptimePct) / 100) * totalWindowMinutes;
  const remainingDowntimeMinutes = Number(Math.max(0, allowedDowntimeMinutes - consumedDowntimeMinutes).toFixed(2));

  return {
    endpointId: metrics.endpointId,
    window: metrics.window,
    uptimePct: metrics.uptimePct,
    checks: metrics.checks,
    failures: metrics.failure,
    slaTargetPct: metrics.slaTargetPct,
    slaMet: metrics.slaMet,
    errorBudgetRemainingPct: metrics.errorBudgetRemainingPct,
    remainingDowntimeMinutes
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
  webhookUrl: string
): Promise<AlertChannel> {
  const current = nowIso();
  const secretName = `netpulse/${orgId}/${type.toLowerCase()}/${channelId}`;
  const secret = await secretsManager.send(
    new CreateSecretCommand({
      Name: secretName,
      SecretString: webhookUrl
    })
  );

  if (!secret.ARN) {
    throw new Error(`Failed to create ${type} webhook secret`);
  }

  const channel: AlertChannel = {
    orgId,
    channelId,
    type,
    target: secret.ARN,
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
  return createSecretBackedChannel(payload.orgId, channelId, "WEBHOOK", payload.webhookUrl);
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
  const uptimePct = total > 0 ? Number((((healthy + degraded) / total) * 100).toFixed(2)) : 100;

  const sparklinePoints = parsed.window === "24h" ? 24 : parsed.window === "7d" ? 14 : 30;
  const sparkline: DashboardSummary["sparkline"] = [];

  for (let i = sparklinePoints - 1; i >= 0; i -= 1) {
    const t = new Date(Date.now() - i * 60 * 60 * 1000).toISOString();
    sparkline.push({ t, uptimePct });
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
    sparkline
  };
}

export async function setEndpointSimulation(endpointId: string, input: unknown): Promise<Endpoint> {
  const parsed = failureSimulationSchema.parse(input);
  const orgId = getOrgIdFromEndpointId(endpointId);
  const updatedAt = nowIso();

  const result = await ddb.send(
    new UpdateCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId },
      UpdateExpression: "SET #simulation = :simulation, #updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#simulation": "simulation",
        "#updatedAt": "updatedAt"
      },
      ExpressionAttributeValues: {
        ":simulation": parsed,
        ":updatedAt": updatedAt
      },
      ConditionExpression: "attribute_exists(orgId) AND attribute_exists(endpointId)",
      ReturnValues: "ALL_NEW"
    })
  );

  return normalizeEndpoint(result.Attributes as Endpoint);
}

export async function clearEndpointSimulation(endpointId: string): Promise<Endpoint> {
  const orgId = getOrgIdFromEndpointId(endpointId);
  const updatedAt = nowIso();

  const result = await ddb.send(
    new UpdateCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId },
      UpdateExpression: "SET #updatedAt = :updatedAt REMOVE #simulation",
      ExpressionAttributeNames: {
        "#updatedAt": "updatedAt",
        "#simulation": "simulation"
      },
      ExpressionAttributeValues: {
        ":updatedAt": updatedAt
      },
      ConditionExpression: "attribute_exists(orgId) AND attribute_exists(endpointId)",
      ReturnValues: "ALL_NEW"
    })
  );

  return normalizeEndpoint(result.Attributes as Endpoint);
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
