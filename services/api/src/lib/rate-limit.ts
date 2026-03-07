import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./db.js";
import { env } from "./env.js";

interface EnforceRateLimitInput {
  key: string;
  maxRequests: number;
  windowSeconds?: number;
  nowMs?: number;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    String((error as { name?: string }).name) === "ConditionalCheckFailedException"
  );
}

export async function enforceRateLimit(input: EnforceRateLimitInput): Promise<void> {
  const windowSeconds = input.windowSeconds ?? env.rateLimitWindowSeconds;
  if (input.maxRequests <= 0 || windowSeconds <= 0 || !env.rateLimitsTable) {
    return;
  }

  const nowMs = input.nowMs ?? Date.now();
  const currentEpoch = Math.floor(nowMs / 1000);
  const bucketStart = Math.floor(currentEpoch / windowSeconds) * windowSeconds;
  const windowKey = `${input.key}:${bucketStart}`;
  const expiresAt = bucketStart + windowSeconds + 60;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.rateLimitsTable,
        Key: { limitKey: windowKey },
        UpdateExpression: "ADD #requestCount :incr SET #expiresAt = :expiresAt, #updatedAt = :updatedAt",
        ConditionExpression: "attribute_not_exists(#requestCount) OR #requestCount < :maxRequests",
        ExpressionAttributeNames: {
          "#requestCount": "requestCount",
          "#expiresAt": "expiresAt",
          "#updatedAt": "updatedAt"
        },
        ExpressionAttributeValues: {
          ":incr": 1,
          ":maxRequests": input.maxRequests,
          ":expiresAt": expiresAt,
          ":updatedAt": new Date(nowMs).toISOString()
        }
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      const retryAfterSeconds = Math.max(1, bucketStart + windowSeconds - currentEpoch);
      throw new Error(`RATE_LIMITED: Too many requests. Retry in ${retryAfterSeconds} seconds`);
    }

    throw error;
  }
}
