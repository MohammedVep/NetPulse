import type { ScheduledEvent } from "aws-lambda";
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { Endpoint, MonitoringRegion, Organization } from "@netpulse/shared";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";
import type { ProbeJob } from "../lib/types.js";

const sqs = new SQSClient({});
const DEFAULT_REGION: MonitoringRegion = "us-east-1";

async function enqueueProbeJobs(jobs: ProbeJob[]): Promise<void> {
  if (!env.probeQueueUrl || jobs.length === 0) {
    return;
  }

  for (let i = 0; i < jobs.length; i += 10) {
    const chunk = jobs.slice(i, i + 10);

    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: env.probeQueueUrl,
        Entries: chunk.map((job, idx) => ({
          Id: `${i + idx}`,
          MessageBody: JSON.stringify(job)
        }))
      })
    );
  }
}

async function listOrganizations(): Promise<Organization[]> {
  const results: Organization[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: env.organizationsTable,
        ExclusiveStartKey: lastKey,
        Limit: 100
      })
    );

    results.push(...((page.Items ?? []) as Organization[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return results.filter((org) => org.isActive);
}

async function listActiveEndpoints(orgId: string): Promise<Endpoint[]> {
  const results: Endpoint[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: env.endpointsTable,
        KeyConditionExpression: "orgId = :orgId",
        ExpressionAttributeValues: {
          ":orgId": orgId
        },
        ExclusiveStartKey: lastKey,
        Limit: 500
      })
    );

    results.push(...((page.Items ?? []) as Endpoint[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return results.filter((endpoint) => !endpoint.paused && endpoint.status !== "DELETED");
}

function resolveRegions(endpoint: Endpoint): MonitoringRegion[] {
  const regions = endpoint.checkRegions ?? [DEFAULT_REGION];
  if (regions.length === 0) {
    return [DEFAULT_REGION];
  }
  return [...new Set(regions)];
}

export async function handler(_event: ScheduledEvent) {
  const organizations = await listOrganizations();
  let queued = 0;

  for (const org of organizations) {
    const endpoints = await listActiveEndpoints(org.orgId);
    const jobs: ProbeJob[] = [];

    for (const endpoint of endpoints) {
      for (const region of resolveRegions(endpoint)) {
        jobs.push({
          orgId: endpoint.orgId,
          endpointId: endpoint.endpointId,
          url: endpoint.url,
          timeoutMs: endpoint.timeoutMs,
          region,
          ...(endpoint.simulation ? { simulation: endpoint.simulation } : {})
        });
      }
    }

    await enqueueProbeJobs(jobs);
    queued += jobs.length;
  }

  return {
    queued,
    organizations: organizations.length,
    timestamp: new Date().toISOString()
  };
}
