import type { ScheduledEvent } from "aws-lambda";
import {
  DeleteSecretCommand,
  ListSecretsCommand,
  SecretsManagerClient,
  type SecretListEntry,
  type Tag
} from "@aws-sdk/client-secrets-manager";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { AlertChannel } from "@netpulse/shared";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";

const secretsManager = new SecretsManagerClient({});
const MANAGED_SECRET_TAG = "netpulse:managed";
const DEPLOYMENT_ENV_TAG = "netpulse:env";
const MANAGED_SECRET_PREFIX = `netpulse/${env.deploymentEnv}/`;

function tagValue(tags: Tag[] | undefined, key: string): string | undefined {
  return tags?.find((tag) => tag.Key === key)?.Value;
}

function isEnvManagedSecret(secret: SecretListEntry): boolean {
  const name = secret.Name ?? "";
  if (!name.startsWith(MANAGED_SECRET_PREFIX)) {
    return false;
  }

  return tagValue(secret.Tags, MANAGED_SECRET_TAG) === "true" && tagValue(secret.Tags, DEPLOYMENT_ENV_TAG) === env.deploymentEnv;
}

function hasGraceElapsed(secret: SecretListEntry): boolean {
  const graceHours = Math.max(1, env.secretJanitorGraceHours);
  const referenceDate = secret.LastChangedDate ?? secret.CreatedDate;
  if (!referenceDate) {
    return false;
  }

  return Date.now() - referenceDate.getTime() >= graceHours * 60 * 60 * 1000;
}

async function listAlertChannels(): Promise<AlertChannel[]> {
  const items: AlertChannel[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: env.alertChannelsTable,
        ExclusiveStartKey: lastKey,
        Limit: 100
      })
    );

    items.push(...((page.Items ?? []) as AlertChannel[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

async function listManagedSecrets(): Promise<SecretListEntry[]> {
  const secrets: SecretListEntry[] = [];
  let nextToken: string | undefined;

  do {
    const page = await secretsManager.send(
      new ListSecretsCommand({
        NextToken: nextToken,
        MaxResults: 100
      })
    );

    secrets.push(...(page.SecretList ?? []).filter(isEnvManagedSecret));
    nextToken = page.NextToken;
  } while (nextToken);

  return secrets;
}

export async function handler(_event: ScheduledEvent) {
  const [channels, secrets] = await Promise.all([listAlertChannels(), listManagedSecrets()]);
  const activeSecretTargets = new Set(
    channels
      .filter((channel) => (channel.type === "SLACK" || channel.type === "WEBHOOK") && channel.target.startsWith("arn:"))
      .map((channel) => channel.target)
  );

  const deleteCandidates = secrets.filter((secret) => {
    if (!secret.ARN || secret.DeletedDate) {
      return false;
    }

    return !activeSecretTargets.has(secret.ARN) && hasGraceElapsed(secret);
  });

  const deletedSecretNames: string[] = [];
  for (const secret of deleteCandidates) {
    if (!secret.ARN) {
      continue;
    }

    await secretsManager.send(
      new DeleteSecretCommand({
        SecretId: secret.ARN,
        ForceDeleteWithoutRecovery: true
      })
    );
    deletedSecretNames.push(secret.Name ?? secret.ARN);
  }

  const summary = {
    deploymentEnv: env.deploymentEnv,
    scannedAlertChannels: channels.length,
    scannedManagedSecrets: secrets.length,
    activeManagedSecretTargets: activeSecretTargets.size,
    deletedSecrets: deletedSecretNames.length,
    deletedSecretNames,
    timestamp: new Date().toISOString()
  };

  console.log(JSON.stringify({ event: "secret_janitor_completed", ...summary }));
  return summary;
}
