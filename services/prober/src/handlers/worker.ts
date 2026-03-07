import { randomUUID } from "node:crypto";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type {
  AlertEvent,
  Endpoint,
  EndpointStatus,
  Incident,
  MonitoringRegion,
  RegionCircuitState
} from "@netpulse/shared";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";
import { circuitOpenProbe, executeProbe } from "../lib/probe.js";
import { nextConsecutiveFailures, shouldOpenIncident, shouldResolveIncident } from "../lib/incident.js";
import type { IncidentNotificationEvent, ProbeJob, WsEvent } from "../lib/types.js";

const sqs = new SQSClient({});
const DEFAULT_REGION: MonitoringRegion = "us-east-1";

const RETENTION_DAYS = 90;
const DEFAULT_SLA_TARGET_PCT = 99.9;
const DEFAULT_LATENCY_THRESHOLD_MS = 2000;
const DEFAULT_FAILURE_RATE_THRESHOLD_PCT = 5;
const ALERT_BURN_RATE_THRESHOLD = 2;
const ALERT_EVAL_SAMPLE_SIZE = 40;
const ALERT_MIN_SAMPLE_SIZE = 3;
const CIRCUIT_OPEN_AFTER_FAILURES = 5;
const CIRCUIT_BASE_COOLDOWN_SECONDS = 120;
const CIRCUIT_MAX_COOLDOWN_SECONDS = 1800;

function ttlFromIso(timestampIso: string): number {
  const now = new Date(timestampIso).getTime();
  const expires = now + RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.floor(expires / 1000);
}

async function emitWsEvent(event: WsEvent): Promise<void> {
  if (!env.wsEventsQueueUrl) {
    return;
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: env.wsEventsQueueUrl,
      MessageBody: JSON.stringify(event)
    })
  );
}

async function emitIncidentNotification(event: IncidentNotificationEvent): Promise<void> {
  if (!env.incidentEventsQueueUrl) {
    return;
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: env.incidentEventsQueueUrl,
      MessageBody: JSON.stringify(event)
    })
  );
}

async function getEndpoint(orgId: string, endpointId: string): Promise<Endpoint | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.endpointsTable,
      Key: { orgId, endpointId }
    })
  );

  return (result.Item as Endpoint | undefined) ?? null;
}

function normalizeRegion(region: MonitoringRegion | undefined): MonitoringRegion {
  return region ?? DEFAULT_REGION;
}

function normalizeEndpoint(endpoint: Endpoint): Endpoint {
  return {
    ...endpoint,
    checkRegions: endpoint.checkRegions?.length ? endpoint.checkRegions : [DEFAULT_REGION],
    regionFailures: endpoint.regionFailures ?? {},
    slaTargetPct: endpoint.slaTargetPct ?? DEFAULT_SLA_TARGET_PCT,
    latencyThresholdMs: endpoint.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS,
    failureRateThresholdPct: endpoint.failureRateThresholdPct ?? DEFAULT_FAILURE_RATE_THRESHOLD_PCT,
    regionCircuitState: endpoint.regionCircuitState ?? {}
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoPlusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function calculateBurnRate(failureRatePct: number, slaTargetPct: number): number {
  const budgetFraction = Math.max(0, (100 - slaTargetPct) / 100);
  if (budgetFraction === 0) {
    return failureRatePct > 0 ? 9999 : 0;
  }

  return Number(((failureRatePct / 100) / budgetFraction).toFixed(2));
}

function cooldownSeconds(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - CIRCUIT_OPEN_AFTER_FAILURES);
  const raw = CIRCUIT_BASE_COOLDOWN_SECONDS * 2 ** exponent;
  return Math.min(CIRCUIT_MAX_COOLDOWN_SECONDS, raw);
}

function currentCircuitState(
  endpoint: Endpoint,
  region: MonitoringRegion
): RegionCircuitState {
  const current = endpoint.regionCircuitState?.[region];
  if (!current) {
    return {
      state: "CLOSED",
      consecutiveFailures: 0
    };
  }

  return current;
}

function shouldShortCircuit(state: RegionCircuitState, now: number): boolean {
  if (state.state !== "OPEN") {
    return false;
  }

  if (!state.nextAttemptAtIso) {
    return true;
  }

  return Date.parse(state.nextAttemptAtIso) > now;
}

function markHalfOpen(state: RegionCircuitState, nowTimestampIso: string): RegionCircuitState {
  if (state.state !== "OPEN") {
    return state;
  }

  return {
    ...state,
    state: "HALF_OPEN",
    halfOpenAtIso: nowTimestampIso
  };
}

function nextCircuitState(
  current: RegionCircuitState,
  nowTimestampIso: string,
  probeOk: boolean,
  consecutiveFailures: number
): RegionCircuitState {
  if (probeOk) {
    return {
      state: "CLOSED",
      consecutiveFailures: 0
    };
  }

  const nextFailureCount = Math.max(current.consecutiveFailures, consecutiveFailures);

  if (current.state === "HALF_OPEN" || nextFailureCount >= CIRCUIT_OPEN_AFTER_FAILURES) {
    return {
      state: "OPEN",
      openedAtIso: nowTimestampIso,
      nextAttemptAtIso: isoPlusSeconds(nowTimestampIso, cooldownSeconds(nextFailureCount)),
      consecutiveFailures: nextFailureCount
    };
  }

  return {
    state: "CLOSED",
    consecutiveFailures: nextFailureCount
  };
}

function hasExpiredSimulation(endpoint: Endpoint): boolean {
  const expiresAtIso = endpoint.simulation?.expiresAtIso;
  if (!expiresAtIso) {
    return false;
  }

  return new Date(expiresAtIso).getTime() <= Date.now();
}

function nextStatusForRegions(
  regionFailures: Partial<Record<MonitoringRegion, number>>,
  checkRegions: MonitoringRegion[],
  paused: boolean,
  forceDegraded: boolean
): EndpointStatus {
  if (paused) {
    return "PAUSED";
  }

  const regions = checkRegions.length > 0 ? checkRegions : [DEFAULT_REGION];
  let regionsDown = 0;

  for (const region of regions) {
    if ((regionFailures[region] ?? 0) >= 2) {
      regionsDown += 1;
    }
  }

  if (regionsDown === 0) {
    return forceDegraded ? "DEGRADED" : "HEALTHY";
  }

  return regionsDown === regions.length ? "DOWN" : "DEGRADED";
}

function maxConsecutiveFailures(regionFailures: Partial<Record<MonitoringRegion, number>>): number {
  const values = Object.values(regionFailures).filter((value): value is number => typeof value === "number");
  return values.length === 0 ? 0 : Math.max(...values);
}

async function getOpenIncident(
  orgId: string,
  endpointId: string,
  region: MonitoringRegion
): Promise<Incident | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.incidentsTable,
      KeyConditionExpression: "incidentPk = :incidentPk",
      ExpressionAttributeValues: {
        ":incidentPk": `${orgId}#${endpointId}`
      },
      ScanIndexForward: false,
      Limit: 10
    })
  );

  const open = (result.Items ?? []).find(
    (item) =>
      item.state === "OPEN" &&
      normalizeRegion((item as { region?: MonitoringRegion }).region) === region
  ) as Incident | undefined;
  return open ?? null;
}

interface RegionProbeStats {
  checks: number;
  failures: number;
  failureRatePct: number;
  avgLatencyMs: number;
  burnRate: number;
}

async function loadRecentRegionStats(
  orgId: string,
  endpointId: string,
  region: MonitoringRegion,
  slaTargetPct: number
): Promise<RegionProbeStats> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.probeResultsTable,
      KeyConditionExpression: "probePk = :probePk",
      ExpressionAttributeValues: {
        ":probePk": `${orgId}#${endpointId}`
      },
      ScanIndexForward: false,
      Limit: ALERT_EVAL_SAMPLE_SIZE * 4
    })
  );

  const regionItems = (result.Items ?? [])
    .filter((item) => normalizeRegion((item as { region?: MonitoringRegion }).region) === region)
    .slice(0, ALERT_EVAL_SAMPLE_SIZE) as Array<{ ok?: boolean; latencyMs?: number }>;

  const checks = regionItems.length;
  const failures = regionItems.filter((item) => item.ok === false).length;
  const failureRatePct = checks > 0 ? Number(((failures / checks) * 100).toFixed(2)) : 0;
  const latencyValues = regionItems
    .map((item) => item.latencyMs)
    .filter((value): value is number => typeof value === "number");
  const avgLatencyMs =
    latencyValues.length > 0
      ? Number((latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length).toFixed(2))
      : 0;
  const burnRate = calculateBurnRate(failureRatePct, slaTargetPct);

  return {
    checks,
    failures,
    failureRatePct,
    avgLatencyMs,
    burnRate
  };
}

async function emitDerivedAlert(
  params: {
    orgId: string;
    endpointId: string;
    region: MonitoringRegion;
    traceId: string;
    ts: string;
    eventType: AlertEvent;
    message: string;
    threshold: number;
  },
  stats: RegionProbeStats
): Promise<void> {
  const correlationId = randomUUID();

  await emitIncidentNotification({
    orgId: params.orgId,
    endpointId: params.endpointId,
    region: params.region,
    incidentId: `alert_${params.eventType.toLowerCase()}_${params.endpointId}_${params.region}`,
    state: "OPEN",
    correlationId,
    traceId: params.traceId,
    alertEvent: params.eventType,
    message: params.message,
    metrics: {
      checks: stats.checks,
      failures: stats.failures,
      failureRatePct: stats.failureRatePct,
      avgLatencyMs: stats.avgLatencyMs,
      burnRate: stats.burnRate,
      threshold: params.threshold
    },
    openedAt: params.ts
  });
}

async function processJob(job: ProbeJob): Promise<void> {
  const traceId = job.traceId ?? randomUUID();
  const endpointRecord = await getEndpoint(job.orgId, job.endpointId);
  if (!endpointRecord) {
    return;
  }

  const endpoint = normalizeEndpoint(endpointRecord);
  if (hasExpiredSimulation(endpoint)) {
    await ddb.send(
      new UpdateCommand({
        TableName: env.endpointsTable,
        Key: { orgId: endpoint.orgId, endpointId: endpoint.endpointId },
        UpdateExpression: "REMOVE #simulation",
        ExpressionAttributeNames: {
          "#simulation": "simulation"
        }
      })
    );
    delete endpoint.simulation;
  }

  if (endpoint.paused || endpoint.status === "DELETED") {
    return;
  }

  const region = normalizeRegion(job.region);
  if (!endpoint.checkRegions.includes(region)) {
    return;
  }

  const circuitBefore = currentCircuitState(endpoint, region);
  const currentTs = Date.now();
  const circuitOpen = shouldShortCircuit(circuitBefore, currentTs);
  const effectiveCircuit =
    !circuitOpen &&
    circuitBefore.state === "OPEN" &&
    (!circuitBefore.nextAttemptAtIso || Date.parse(circuitBefore.nextAttemptAtIso) <= currentTs)
      ? markHalfOpen(circuitBefore, nowIso())
      : circuitBefore;

  console.log(
    JSON.stringify({
      event: "probe_job_started",
      traceId,
      orgId: job.orgId,
      endpointId: job.endpointId,
      region,
      circuitState: effectiveCircuit.state
    })
  );

  const probe = circuitOpen
    ? circuitOpenProbe({
        ...job,
        region,
        traceId,
        ...(endpoint.simulation ? { simulation: endpoint.simulation } : {})
      })
    : await executeProbe({
        ...job,
        region,
        traceId,
        ...(endpoint.simulation ? { simulation: endpoint.simulation } : {})
      });
  const previousFailures = endpoint.regionFailures[region] ?? 0;
  const nextFailures = nextConsecutiveFailures(previousFailures, probe.ok);
  const regionFailures: Partial<Record<MonitoringRegion, number>> = {
    ...endpoint.regionFailures,
    [region]: nextFailures
  };
  const nextRegionCircuitState: Partial<Record<MonitoringRegion, RegionCircuitState>> = {
    ...(endpoint.regionCircuitState ?? {}),
    [region]: nextCircuitState(effectiveCircuit, probe.timestampIso, probe.ok, nextFailures)
  };
  const status = nextStatusForRegions(
    regionFailures,
    endpoint.checkRegions,
    endpoint.paused,
    probe.simulationMode === "FORCE_DEGRADED"
  );
  const consecutiveFailures = maxConsecutiveFailures(regionFailures);

  await Promise.all([
    ddb.send(
      new PutCommand({
        TableName: env.probeResultsTable,
        Item: {
          probePk: `${job.orgId}#${job.endpointId}`,
          timestampIso: probe.timestampIso,
          orgId: job.orgId,
          endpointId: job.endpointId,
          region,
          statusCode: probe.statusCode,
          latencyMs: probe.latencyMs,
          ok: probe.ok,
          errorType: probe.errorType,
          classification: probe.classification,
          simulated: probe.simulated === true,
          traceId,
          expiresAt: ttlFromIso(probe.timestampIso)
        }
      })
    ),
    ddb.send(
      new UpdateCommand({
        TableName: env.endpointsTable,
        Key: { orgId: job.orgId, endpointId: job.endpointId },
        UpdateExpression:
          "SET #status = :status, #lastCheckedAt = :lastCheckedAt, #lastStatusCode = :lastStatusCode, #lastLatencyMs = :lastLatencyMs, #consecutiveFailures = :consecutiveFailures, #regionFailures = :regionFailures, #regionCircuitState = :regionCircuitState, #updatedAt = :updatedAt, #statusUpdatedAt = :statusUpdatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
          "#lastCheckedAt": "lastCheckedAt",
          "#lastStatusCode": "lastStatusCode",
          "#lastLatencyMs": "lastLatencyMs",
          "#consecutiveFailures": "consecutiveFailures",
          "#regionFailures": "regionFailures",
          "#regionCircuitState": "regionCircuitState",
          "#updatedAt": "updatedAt",
          "#statusUpdatedAt": "statusUpdatedAt"
        },
        ExpressionAttributeValues: {
          ":status": status,
          ":lastCheckedAt": probe.timestampIso,
          ":lastStatusCode": probe.statusCode ?? -1,
          ":lastLatencyMs": probe.latencyMs ?? 0,
          ":consecutiveFailures": consecutiveFailures,
          ":regionFailures": regionFailures,
          ":regionCircuitState": nextRegionCircuitState,
          ":updatedAt": probe.timestampIso,
          ":statusUpdatedAt": `${status}#${probe.timestampIso}`
        }
      })
    )
  ]);

  console.log(
    JSON.stringify({
      event: "probe_job_completed",
      traceId,
      orgId: job.orgId,
      endpointId: job.endpointId,
      region,
      ok: probe.ok,
      statusCode: probe.statusCode,
      latencyMs: probe.latencyMs,
      classification: probe.classification,
      attempts: probe.attemptCount ?? 1,
      circuitState: nextRegionCircuitState[region]?.state ?? "CLOSED"
    })
  );

  const openIncident = await getOpenIncident(job.orgId, job.endpointId, region);
  const shouldOpen = shouldOpenIncident(nextFailures) && !openIncident;
  const shouldResolve = shouldResolveIncident(Boolean(openIncident), probe.ok);
  const incidentState = shouldResolve ? "RESOLVED" : shouldOpen ? "OPEN" : openIncident?.state ?? "NONE";

  await emitWsEvent({
    type: "health_update",
    orgId: job.orgId,
    endpointId: job.endpointId,
    payload: {
      region,
      ts: probe.timestampIso,
      status,
      ...(typeof probe.latencyMs === "number" ? { latencyMs: probe.latencyMs } : {}),
      ...(typeof probe.statusCode === "number" ? { statusCode: probe.statusCode } : {}),
      incidentState
    }
  });

  if (shouldOpen) {
    const correlationId = randomUUID();
    const incident: Incident = {
      incidentId: `inc_${randomUUID()}`,
      orgId: job.orgId,
      endpointId: job.endpointId,
      region,
      state: "OPEN",
      openedAt: probe.timestampIso,
      failureCount: nextFailures,
      ...(probe.errorType ? { latestError: probe.errorType } : {})
    };

    await ddb.send(
      new PutCommand({
        TableName: env.incidentsTable,
        Item: {
          ...incident,
          incidentPk: `${job.orgId}#${job.endpointId}`,
          openedAtIso: incident.openedAt,
          stateOpenedAt: `OPEN#${incident.openedAt}`
        }
      })
    );

    await Promise.all([
      emitIncidentNotification({
        orgId: incident.orgId,
        endpointId: incident.endpointId,
        region,
        incidentId: incident.incidentId,
        state: incident.state,
        correlationId,
        traceId,
        alertEvent: "INCIDENT_OPEN",
        openedAt: incident.openedAt
      }),
      emitWsEvent({
        type: "incident_update",
        orgId: incident.orgId,
        endpointId: incident.endpointId,
        payload: {
          region,
          incidentId: incident.incidentId,
          state: incident.state,
          openedAt: incident.openedAt
        }
      })
    ]);
  }

  if (shouldResolve && openIncident) {
    const correlationId = randomUUID();
    const resolvedAt = probe.timestampIso;

    await ddb.send(
      new UpdateCommand({
        TableName: env.incidentsTable,
        Key: {
          incidentPk: `${job.orgId}#${job.endpointId}`,
          openedAtIso: openIncident.openedAt
        },
        UpdateExpression:
          "SET #state = :state, #resolvedAt = :resolvedAt, #stateOpenedAt = :stateOpenedAt",
        ExpressionAttributeNames: {
          "#state": "state",
          "#resolvedAt": "resolvedAt",
          "#stateOpenedAt": "stateOpenedAt"
        },
        ExpressionAttributeValues: {
          ":state": "RESOLVED",
          ":resolvedAt": resolvedAt,
          ":stateOpenedAt": `RESOLVED#${openIncident.openedAt}`
        }
      })
    );

    await Promise.all([
      emitIncidentNotification({
        orgId: job.orgId,
        endpointId: job.endpointId,
        region,
        incidentId: openIncident.incidentId,
        state: "RESOLVED",
        correlationId,
        traceId,
        alertEvent: "INCIDENT_RESOLVED",
        openedAt: openIncident.openedAt,
        resolvedAt
      }),
      emitWsEvent({
        type: "incident_update",
        orgId: job.orgId,
        endpointId: job.endpointId,
        payload: {
          region,
          incidentId: openIncident.incidentId,
          state: "RESOLVED",
          openedAt: openIncident.openedAt,
          resolvedAt
        }
      })
    ]);
  }

  const recentStats = await loadRecentRegionStats(
    job.orgId,
    job.endpointId,
    region,
    endpoint.slaTargetPct ?? DEFAULT_SLA_TARGET_PCT
  );

  if (recentStats.checks >= ALERT_MIN_SAMPLE_SIZE) {
    const derivedAlerts: Promise<void>[] = [];
    const latencyThresholdMs = endpoint.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS;
    const failureRateThresholdPct =
      endpoint.failureRateThresholdPct ?? DEFAULT_FAILURE_RATE_THRESHOLD_PCT;

    if (recentStats.avgLatencyMs > latencyThresholdMs) {
      derivedAlerts.push(
        emitDerivedAlert(
          {
            orgId: job.orgId,
            endpointId: job.endpointId,
            region,
            traceId,
            ts: probe.timestampIso,
            eventType: "LATENCY_BREACH",
            message: `Latency breach in ${region}: avg ${recentStats.avgLatencyMs}ms above threshold ${latencyThresholdMs}ms`,
            threshold: latencyThresholdMs
          },
          recentStats
        )
      );
    }

    if (recentStats.failureRatePct > failureRateThresholdPct) {
      derivedAlerts.push(
        emitDerivedAlert(
          {
            orgId: job.orgId,
            endpointId: job.endpointId,
            region,
            traceId,
            ts: probe.timestampIso,
            eventType: "FAILURE_RATE_BREACH",
            message: `Failure-rate breach in ${region}: ${recentStats.failureRatePct}% above threshold ${failureRateThresholdPct}%`,
            threshold: failureRateThresholdPct
          },
          recentStats
        )
      );
    }

    if (recentStats.burnRate >= ALERT_BURN_RATE_THRESHOLD) {
      derivedAlerts.push(
        emitDerivedAlert(
          {
            orgId: job.orgId,
            endpointId: job.endpointId,
            region,
            traceId,
            ts: probe.timestampIso,
            eventType: "SLO_BURN_RATE",
            message: `SLO burn-rate alert in ${region}: burn rate ${recentStats.burnRate}x`,
            threshold: ALERT_BURN_RATE_THRESHOLD
          },
          recentStats
        )
      );
    }

    if (derivedAlerts.length > 0) {
      await Promise.all(derivedAlerts);
    }
  }
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        const job = JSON.parse(record.body) as ProbeJob;
        await processJob(job);
      } catch (error) {
        console.error("probe worker failed", { error, recordId: record.messageId });
        failures.push({ itemIdentifier: record.messageId });
      }
    })
  );

  return {
    batchItemFailures: failures
  };
}
