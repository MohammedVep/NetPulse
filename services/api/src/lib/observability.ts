import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

export function getHeader(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  name: string
): string | undefined {
  const headers = event.headers ?? {};
  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value) {
      return value;
    }
  }

  return undefined;
}

export function correlationIdForEvent(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): string {
  return (
    getHeader(event, "x-correlation-id") ??
    getHeader(event, "x-request-id") ??
    event.requestContext.requestId
  );
}

export function logInfo(event: string, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "INFO",
      event,
      service: "np-api-rest",
      ts: new Date().toISOString(),
      ...details
    })
  );
}

export function logError(event: string, details: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: "ERROR",
      event,
      service: "np-api-rest",
      ts: new Date().toISOString(),
      ...details
    })
  );
}
