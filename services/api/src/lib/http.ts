import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export function json(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(extraHeaders ?? {})
    },
    body: JSON.stringify(body)
  };
}

export function noContent(extraHeaders?: Record<string, string>): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 204,
    ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {})
  };
}

export function getBody<T>(rawBody?: string | null): T {
  if (!rawBody) {
    throw new Error("Request body is required");
  }

  return JSON.parse(rawBody) as T;
}

export function fail(
  error: unknown,
  options?: {
    requestId?: string;
    correlationId?: string;
  }
): APIGatewayProxyStructuredResultV2 {
  const message = error instanceof Error ? error.message : "Unknown error";
  const isZodError =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    String((error as { name?: string }).name) === "ZodError";
  const codedMessage = message.match(/^([A-Z_]+):\s*(.+)$/);
  const errorCode = codedMessage ? codedMessage[1] : undefined;
  const normalizedMessage = codedMessage ? codedMessage[2] : message;
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
        : errorCode === "RATE_LIMITED" || lower.includes("rate limit")
          ? 429
        : isZodError || lower.includes("required") || lower.includes("invalid") || lower.includes("validation")
          ? 400
          : 500;

  return json(statusCode, {
    code: errorCode ?? `ERR_${statusCode}`,
    message: normalizedMessage,
    requestId: options?.requestId
  }, {
    ...(options?.requestId ? { "x-request-id": options.requestId } : {}),
    ...(options?.correlationId ? { "x-correlation-id": options.correlationId } : {})
  });
}
