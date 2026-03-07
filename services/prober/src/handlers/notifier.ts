import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { AlertChannel, AlertEvent } from "@netpulse/shared";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";
import type { IncidentNotificationEvent } from "../lib/types.js";

const sns = new SNSClient({});
const secretsManager = new SecretsManagerClient({});
const secretCache = new Map<string, string>();
const DEDUPE_WINDOW_SECONDS = 10 * 60;
const MAX_WEBHOOK_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

interface WebhookTargetConfig {
  url: string;
  secretHeaderName?: string;
  secretHeaderValue?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextBackoffMs(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
  return exp + Math.floor(Math.random() * 100);
}

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

function toAlertEvent(state: IncidentNotificationEvent["state"]): AlertEvent {
  return state === "OPEN" ? "INCIDENT_OPEN" : "INCIDENT_RESOLVED";
}

function shouldSend(channel: AlertChannel, eventType: AlertEvent): boolean {
  if (!channel.events || channel.events.length === 0) {
    return true;
  }

  return channel.events.includes(eventType);
}

function resolveAlertEvent(event: IncidentNotificationEvent): AlertEvent {
  if (event.alertEvent) {
    return event.alertEvent;
  }

  return toAlertEvent(event.state);
}

function messageFor(event: IncidentNotificationEvent): string {
  if (event.message) {
    return event.message;
  }

  const status = event.state === "OPEN" ? "DOWN" : "RECOVERED";
  const regionSuffix = event.region ? ` region ${event.region}` : "";
  return `NetPulse incident ${status} for endpoint ${event.endpointId}${regionSuffix} in org ${event.orgId}. Incident: ${event.incidentId}. Correlation: ${event.correlationId}.`;
}

async function notifyEmail(event: IncidentNotificationEvent): Promise<void> {
  if (!env.emailTopicArn) {
    return;
  }

  const response = await sns.send(
    new PublishCommand({
      TopicArn: env.emailTopicArn,
      Subject: `NetPulse Alert ${resolveAlertEvent(event)} (${event.orgId})`,
      Message: messageFor(event),
      MessageAttributes: {
        correlationId: {
          DataType: "String",
          StringValue: event.correlationId
        }
      }
    })
  );

  console.log(
    JSON.stringify({
      event: "incident_notifier_delivered",
      channel: "EMAIL",
      alertEvent: resolveAlertEvent(event),
      state: event.state,
      orgId: event.orgId,
      endpointId: event.endpointId,
      incidentId: event.incidentId,
      correlationId: event.correlationId,
      traceId: event.traceId,
      statusCode: 200,
      providerResponse: response.MessageId ?? "no-message-id"
    })
  );
}

async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<{ statusCode: number; providerResponse: string }> {
  let lastFailure: string | undefined;
  for (let attempt = 1; attempt <= MAX_WEBHOOK_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(headers ?? {})
        },
        body: JSON.stringify(body)
      });

      const responseText = (await response.text()).slice(0, 256);
      const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!response.ok) {
        lastFailure = `provider status ${response.status} body=${responseText}`;
        if (attempt < MAX_WEBHOOK_ATTEMPTS && retryable) {
          await sleep(nextBackoffMs(attempt));
          continue;
        }

        throw new Error(`WEBHOOK_DELIVERY_FAILED: ${lastFailure}`);
      }

      return {
        statusCode: response.status,
        providerResponse: responseText
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const alreadyWrapped = message.startsWith("WEBHOOK_DELIVERY_FAILED:");
      lastFailure = message;
      if (attempt < MAX_WEBHOOK_ATTEMPTS && !alreadyWrapped) {
        await sleep(nextBackoffMs(attempt));
        continue;
      }

      if (alreadyWrapped) {
        throw error;
      }

      throw new Error(`WEBHOOK_DELIVERY_FAILED: ${lastFailure}`);
    }
  }

  throw new Error(`WEBHOOK_DELIVERY_FAILED: ${lastFailure ?? "unknown failure"}`);
}

async function notifySlack(webhookUrl: string, event: IncidentNotificationEvent): Promise<void> {
  const delivery = await postJson(webhookUrl, {
    text: messageFor(event)
  });

  console.log(
    JSON.stringify({
      event: "incident_notifier_delivered",
      channel: "SLACK",
      alertEvent: resolveAlertEvent(event),
      state: event.state,
      orgId: event.orgId,
      endpointId: event.endpointId,
      incidentId: event.incidentId,
      correlationId: event.correlationId,
      traceId: event.traceId,
      statusCode: delivery.statusCode,
      providerResponse: delivery.providerResponse
    })
  );
}

async function notifyWebhook(
  webhook: WebhookTargetConfig,
  event: IncidentNotificationEvent,
  channel: AlertChannel
): Promise<void> {
  const delivery = await postJson(
    webhook.url,
    {
      source: "netpulse",
      type: "incident",
      eventType: toAlertEvent(event.state),
      ...event,
      message: messageFor(event)
    },
    webhook.secretHeaderName && webhook.secretHeaderValue
      ? {
          [webhook.secretHeaderName]: webhook.secretHeaderValue
        }
      : undefined
  );

  console.log(
    JSON.stringify({
      event: "incident_notifier_delivered",
      channel: "WEBHOOK",
      channelId: channel.channelId,
      alertEvent: resolveAlertEvent(event),
      state: event.state,
      orgId: event.orgId,
      endpointId: event.endpointId,
      incidentId: event.incidentId,
      correlationId: event.correlationId,
      traceId: event.traceId,
      statusCode: delivery.statusCode,
      providerResponse: delivery.providerResponse
    })
  );
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

async function loadSecretValue(secretArn: string): Promise<string> {
  const cached = secretCache.get(secretArn);
  if (cached) {
    return cached;
  }

  const response = await secretsManager.send(
    new GetSecretValueCommand({
      SecretId: secretArn
    })
  );
  const secretValue = response.SecretString;

  if (!secretValue) {
    throw new Error(`Missing webhook secret value for ${secretArn}`);
  }

  secretCache.set(secretArn, secretValue);
  return secretValue;
}

async function resolveWebhookTarget(channel: AlertChannel): Promise<WebhookTargetConfig> {
  if (channel.target.startsWith("https://")) {
    return {
      url: channel.target
    };
  }

  const secretValue = await loadSecretValue(channel.target);
  try {
    const parsed = JSON.parse(secretValue) as Partial<WebhookTargetConfig>;
    if (parsed.url && parsed.url.startsWith("https://")) {
      return {
        url: parsed.url,
        ...(parsed.secretHeaderName && parsed.secretHeaderValue
          ? {
              secretHeaderName: parsed.secretHeaderName,
              secretHeaderValue: parsed.secretHeaderValue
            }
          : {})
      };
    }
  } catch {
    // fall through to plain URL secret format
  }

  if (!secretValue.startsWith("https://")) {
    throw new Error(`WEBHOOK_DELIVERY_FAILED: invalid webhook target for ${channel.channelId}`);
  }

  return {
    url: secretValue
  };
}

async function processEvent(message: IncidentNotificationEvent): Promise<void> {
  const channels = await loadChannels(message.orgId);
  const activeChannels = channels.filter((channel) => !channel.muted && channel.verified);
  const alertEvent = resolveAlertEvent(message);

  if (activeChannels.some((channel) => channel.type === "EMAIL" && shouldSend(channel, alertEvent))) {
    const emailDedupeKey = `${message.orgId}:${message.endpointId}:${message.region ?? "global"}:${alertEvent}:EMAIL`;
    if (await claimNotificationSlot(emailDedupeKey)) {
      await notifyEmail(message);
    }
  }

  for (const channel of activeChannels.filter((item) => item.type === "SLACK" || item.type === "WEBHOOK")) {
    if (!shouldSend(channel, alertEvent)) {
      continue;
    }

    const dedupeKey = `${message.orgId}:${message.endpointId}:${message.region ?? "global"}:${alertEvent}:${channel.channelId}`;
    if (!(await claimNotificationSlot(dedupeKey))) {
      continue;
    }

    const webhook = await resolveWebhookTarget(channel);
    if (channel.type === "SLACK") {
      await notifySlack(webhook.url, message);
    } else {
      await notifyWebhook(webhook, message, channel);
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
