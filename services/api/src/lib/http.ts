import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

export function noContent(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 204
  };
}

export function getBody<T>(rawBody?: string | null): T {
  if (!rawBody) {
    throw new Error("Request body is required");
  }

  return JSON.parse(rawBody) as T;
}

export function fail(error: unknown, requestId?: string): APIGatewayProxyStructuredResultV2 {
  const message = error instanceof Error ? error.message : "Unknown error";
  const statusCode = message.includes("permission") ||
    message.includes("active org member") ||
    message.includes("lacks permission")
    ? 403
    : message.includes("not found")
      ? 404
      : message.includes("required") || message.includes("Invalid") || message.includes("validation")
        ? 400
        : 500;

  return json(statusCode, {
    code: `ERR_${statusCode}`,
    message,
    requestId
  });
}
