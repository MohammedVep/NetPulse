import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand
} from "@aws-sdk/client-apigatewaymanagementapi";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";
import type { WsEvent } from "../lib/types.js";

const ws = env.websocketEndpoint
  ? new ApiGatewayManagementApiClient({ endpoint: env.websocketEndpoint })
  : new ApiGatewayManagementApiClient({});

interface WsConnection {
  orgId: string;
  connectionId: string;
  endpointIds?: string[];
}

async function listConnections(orgId: string): Promise<WsConnection[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: env.wsConnectionsTable,
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: {
        ":orgId": orgId
      }
    })
  );

  return (result.Items ?? []) as WsConnection[];
}

async function expireConnection(orgId: string, connectionId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: env.wsConnectionsTable,
      Key: { orgId, connectionId },
      UpdateExpression: "SET expiresAt = :expiresAt",
      ExpressionAttributeValues: {
        ":expiresAt": Math.floor(Date.now() / 1000) + 60
      }
    })
  );
}

async function sendToConnection(connection: WsConnection, event: WsEvent): Promise<void> {
  const endpointFilter = connection.endpointIds ?? [];
  if (endpointFilter.length > 0 && !endpointFilter.includes(event.endpointId)) {
    return;
  }

  try {
    await ws.send(
      new PostToConnectionCommand({
        ConnectionId: connection.connectionId,
        Data: JSON.stringify({
          type: event.type,
          orgId: event.orgId,
          endpointId: event.endpointId,
          ...event.payload
        })
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown websocket send error";
    if (message.includes("GoneException") || message.includes("410")) {
      await expireConnection(connection.orgId, connection.connectionId);
      return;
    }

    throw error;
  }
}

async function processMessage(message: WsEvent): Promise<void> {
  const connections = await listConnections(message.orgId);
  await Promise.all(connections.map((connection) => sendToConnection(connection, message)));
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        const parsed = JSON.parse(record.body) as WsEvent;
        await processMessage(parsed);
      } catch (error) {
        console.error("ws broadcaster failed", { error, recordId: record.messageId });
        failures.push({ itemIdentifier: record.messageId });
      }
    })
  );

  return {
    batchItemFailures: failures
  };
}
