import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { AlertChannel } from "@netpulse/shared";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";
import type { IncidentNotificationEvent } from "../lib/types.js";

const sns = new SNSClient({});
const secretsManager = new SecretsManagerClient({});
const secretCache = new Map<string, string>();
const DEDUPE_WINDOW_SECONDS = 10 * 60;

async function loadChannels(orgId: string): Promise<AlertChannel[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.alertChannelsTable,
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: {
        ":orgId": orgId
      }
    })
  );

  return (result.Items ?? []) as AlertChannel[];
}

function messageFor(event: IncidentNotificationEvent): string {
  const status = event.state === "OPEN" ? "DOWN" : "RECOVERED";
  const regionSuffix = event.region ? ` region ${event.region}` : "";
  return `NetPulse incident ${status} for endpoint ${event.endpointId}${regionSuffix} in org ${event.orgId}. Incident: ${event.incidentId}.`;
}

async function notifyEmail(event: IncidentNotificationEvent): Promise<void> {
  if (!env.emailTopicArn) {
    return;
  }

  await sns.send(
    new PublishCommand({
      TopicArn: env.emailTopicArn,
      Subject: `NetPulse Incident ${event.state} (${event.orgId})`,
      Message: messageFor(event)
    })
  );
}

async function notifySlack(webhookUrl: string, event: IncidentNotificationEvent): Promise<void> {
  await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      text: messageFor(event)
    })
  });
}

async function notifyWebhook(webhookUrl: string, event: IncidentNotificationEvent): Promise<void> {
  await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      source: "netpulse",
      type: "incident",
      ...event,
      message: messageFor(event)
    })
  });
}

function isConditionalWriteFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ("name" in error ? String((error as { name?: string }).name) : "") === "ConditionalCheckFailedException"
  );
}

async function claimNotificationSlot(dedupeKey: string): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: env.alertDedupeTable,
        Item: {
          dedupeKey,
          expiresAt: Math.floor(Date.now() / 1000) + DEDUPE_WINDOW_SECONDS
        },
        ConditionExpression: "attribute_not_exists(dedupeKey)"
      })
    );
    return true;
  } catch (error) {
    if (isConditionalWriteFailure(error)) {
      return false;
    }
    throw error;
  }
}

async function resolveWebhookTarget(target: string): Promise<string> {
  if (target.startsWith("https://")) {
    return target;
  }

  const cached = secretCache.get(target);
  if (cached) {
    return cached;
  }

  const response = await secretsManager.send(
    new GetSecretValueCommand({
      SecretId: target
    })
  );
  const secretValue = response.SecretString;

  if (!secretValue) {
    throw new Error(`Missing Slack webhook secret value for ${target}`);
  }

  secretCache.set(target, secretValue);
  return secretValue;
}

async function processEvent(message: IncidentNotificationEvent): Promise<void> {
  const channels = await loadChannels(message.orgId);
  const activeChannels = channels.filter((channel) => !channel.muted && channel.verified);

  if (activeChannels.some((channel) => channel.type === "EMAIL")) {
    const emailDedupeKey = `${message.orgId}:${message.endpointId}:${message.region ?? "global"}:${message.state}:EMAIL`;
    if (await claimNotificationSlot(emailDedupeKey)) {
      await notifyEmail(message);
    }
  }

  for (const channel of activeChannels.filter((item) => item.type === "SLACK" || item.type === "WEBHOOK")) {
    const dedupeKey = `${message.orgId}:${message.endpointId}:${message.region ?? "global"}:${message.state}:${channel.channelId}`;
    if (!(await claimNotificationSlot(dedupeKey))) {
      continue;
    }

    const webhookUrl = await resolveWebhookTarget(channel.target);
    if (channel.type === "SLACK") {
      await notifySlack(webhookUrl, message);
    } else {
      await notifyWebhook(webhookUrl, message);
    }
  }
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        const parsed = JSON.parse(record.body) as IncidentNotificationEvent;
        await processEvent(parsed);
      } catch (error) {
        console.error("incident notifier failed", { error, recordId: record.messageId });
        failures.push({ itemIdentifier: record.messageId });
      }
    })
  );

  return {
    batchItemFailures: failures
  };
}
