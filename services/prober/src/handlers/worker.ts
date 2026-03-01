import { randomUUID } from "node:crypto";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Endpoint, EndpointStatus, Incident, MonitoringRegion } from "@netpulse/shared";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";
import { executeProbe } from "../lib/probe.js";
import { nextConsecutiveFailures, shouldOpenIncident, shouldResolveIncident } from "../lib/incident.js";
import type { IncidentNotificationEvent, ProbeJob, WsEvent } from "../lib/types.js";

const sqs = new SQSClient({});
const DEFAULT_REGION: MonitoringRegion = "us-east-1";

const RETENTION_DAYS = 90;

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
    slaTargetPct: endpoint.slaTargetPct ?? 99.9
  };
}

function nextStatusForRegions(
  regionFailures: Partial<Record<MonitoringRegion, number>>,
  checkRegions: MonitoringRegion[],
  paused: boolean
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
    return "HEALTHY";
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

async function processJob(job: ProbeJob): Promise<void> {
  const endpointRecord = await getEndpoint(job.orgId, job.endpointId);
  if (!endpointRecord) {
    return;
  }

  const endpoint = normalizeEndpoint(endpointRecord);
  if (endpoint.paused || endpoint.status === "DELETED") {
    return;
  }

  const region = normalizeRegion(job.region);
  if (!endpoint.checkRegions.includes(region)) {
    return;
  }

  const probe = await executeProbe({
    ...job,
    region,
    ...(endpoint.simulation ? { simulation: endpoint.simulation } : {})
  });
  const previousFailures = endpoint.regionFailures[region] ?? 0;
  const nextFailures = nextConsecutiveFailures(previousFailures, probe.ok);
  const regionFailures: Partial<Record<MonitoringRegion, number>> = {
    ...endpoint.regionFailures,
    [region]: nextFailures
  };
  const status = nextStatusForRegions(regionFailures, endpoint.checkRegions, endpoint.paused);
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
          simulated: probe.simulated === true,
          expiresAt: ttlFromIso(probe.timestampIso)
        }
      })
    ),
    ddb.send(
      new UpdateCommand({
        TableName: env.endpointsTable,
        Key: { orgId: job.orgId, endpointId: job.endpointId },
        UpdateExpression:
          "SET #status = :status, #lastCheckedAt = :lastCheckedAt, #lastStatusCode = :lastStatusCode, #lastLatencyMs = :lastLatencyMs, #consecutiveFailures = :consecutiveFailures, #regionFailures = :regionFailures, #updatedAt = :updatedAt, #statusUpdatedAt = :statusUpdatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
          "#lastCheckedAt": "lastCheckedAt",
          "#lastStatusCode": "lastStatusCode",
          "#lastLatencyMs": "lastLatencyMs",
          "#consecutiveFailures": "consecutiveFailures",
          "#regionFailures": "regionFailures",
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
          ":updatedAt": probe.timestampIso,
          ":statusUpdatedAt": `${status}#${probe.timestampIso}`
        }
      })
    )
  ]);

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
