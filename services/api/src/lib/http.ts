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
  const lower = message.toLowerCase();

  const statusCode = lower.includes("unauthorized") || lower.includes("authenticated identity")
    ? 401
    : lower.includes("permission") ||
      lower.includes("forbidden") ||
      lower.includes("active org member") ||
      lower.includes("lacks permission") ||
      lower.includes("public demo access")
      ? 403
      : lower.includes("not found")
        ? 404
        : lower.includes("required") || lower.includes("invalid") || lower.includes("validation")
          ? 400
          : 500;

  return json(statusCode, {
    code: `ERR_${statusCode}`,
    message,
    requestId
  });
}
