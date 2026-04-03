#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  local message="$1"
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS: $message"
}

fail() {
  local message="$1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL: $message" >&2
}

check_pattern() {
  local file="$1"
  local pattern="$2"
  local description="$3"

  if rg -q --pcre2 "$pattern" "$file"; then
    pass "$description"
  else
    fail "$description (missing pattern '$pattern' in $file)"
  fi
}

echo "Running NetPulse production readiness checks..."

echo
echo "== Authentication (JWT / Cognito) =="
check_pattern "infra/cdk/lib/netpulse-stack.ts" "HttpJwtAuthorizer" \
  "REST API uses JWT authorizer"
check_pattern "services/api/src/handlers/websocket.ts" "CognitoJwtVerifier" \
  "WebSocket connect path verifies Cognito JWT"
check_pattern "services/api/src/handlers/rest.ts" "requireRole\\(" \
  "REST handlers enforce org role checks"

echo
echo "== Rate limiting =="
check_pattern "services/api/src/handlers/rest.ts" "enforceRateLimit\\(" \
  "REST handler enforces application-level rate limiting"
check_pattern "services/api/src/lib/rate-limit.ts" "ConditionExpression:\\s*\"attribute_not_exists\\(#requestCount\\) OR #requestCount < :maxRequests\"" \
  "Rate limiter uses atomic DynamoDB conditional counter"
check_pattern "infra/cdk/lib/netpulse-stack.ts" "throttlingRateLimit:\\s*100" \
  "API Gateway stage throttling is configured"

echo
echo "== Retries and backoff =="
check_pattern "services/prober/src/lib/probe.ts" "result\\.errorType === \"TIMEOUT\"\\s*\\|\\|" \
  "Probe execution retries timeout failures"
check_pattern "services/prober/src/lib/probe.ts" "backoffMs\\(" \
  "Probe execution uses exponential backoff"
check_pattern "services/prober/src/handlers/notifier.ts" "MAX_WEBHOOK_ATTEMPTS\\s*=\\s*3" \
  "Notifier retries webhook delivery"
check_pattern "packages/shared/src/api-client.ts" "shouldRetryStatus\\(" \
  "Shared API client retries transient GET/HEAD failures"

echo
echo "== Logging and tracing =="
check_pattern "infra/cdk/lib/netpulse-stack.ts" "lambdaTracing\\s*=\\s*isProd\\s*\\?\\s*Tracing\\.ACTIVE\\s*:\\s*Tracing\\.PASS_THROUGH" \
  "Prod Lambda X-Ray tracing stays enabled while non-prod tracing can be reduced"
check_pattern "infra/cdk/lib/netpulse-stack.ts" "accessLogSettings\\s*=\\s*\\{" \
  "API Gateway access logs are configured"
check_pattern "services/api/src/lib/observability.ts" "logInfo\\(" \
  "Structured observability helper is present"
check_pattern "services/api/src/handlers/rest.ts" "x-correlation-id" \
  "REST responses include correlation id header"

echo
echo "== Cost awareness =="
check_pattern "services/prober/src/handlers/scheduler.ts" "schedulerMaxJobsPerCycle" \
  "Scheduler applies max jobs per cycle guardrail"
check_pattern "services/prober/src/handlers/scheduler.ts" "schedulerMaxEndpointsPerOrg" \
  "Scheduler applies max endpoints per org guardrail"
check_pattern "infra/cdk/lib/netpulse-stack.ts" "transitionAfter:\\s*Duration\\.days\\(180\\)" \
  "S3 lifecycle transition for report storage is configured"

echo
echo "== Failure handling =="
check_pattern "infra/cdk/lib/netpulse-stack.ts" "deadLetterQueue:\\s*\\{" \
  "Probe queue has a dead-letter queue"
check_pattern "services/prober/src/handlers/worker.ts" "CIRCUIT_OPEN_AFTER_FAILURES\\s*=\\s*5" \
  "Circuit breaker threshold is configured"
check_pattern "services/prober/src/handlers/notifier.ts" "DEDUPE_WINDOW_SECONDS\\s*=\\s*10 \\* 60" \
  "Notifier dedupe window is configured"
check_pattern "services/prober/src/handlers/worker.ts" "shouldOpenIncident\\(" \
  "Incident open transition logic is enforced"
check_pattern "services/prober/src/handlers/worker.ts" "shouldResolveIncident\\(" \
  "Incident resolve transition logic is enforced"

echo
echo "Readiness checks complete: $PASS_COUNT passed, $FAIL_COUNT failed."

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
