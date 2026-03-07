# Production Baseline (All Projects)

This is the minimum production bar applied across NetPulse and future projects.

## 1) Authentication and authorization

- Use short-lived JWTs (Cognito/OIDC) and validate issuer/audience/signature.
- Enforce tenant scoping in every data access path.
- Add role-based permissions and deny by default.

## 2) Rate limiting and abuse controls

- Enforce gateway-level throttling.
- Enforce application-level limits keyed by user/IP/API route.
- Return explicit `429` with retry guidance.

## 3) Retries, backoff, and idempotency

- Retry only transient failures (`429`, `5xx`, network timeouts).
- Use exponential backoff with jitter and bounded max attempts.
- Use idempotency keys for mutating operations.

## 4) Logging, metrics, and tracing

- Structured JSON logs only (no ad-hoc strings).
- Include `requestId`, `correlationId`, and `traceId`.
- Enable distributed tracing for compute paths.
- Emit access logs at ingress (API Gateway/load balancer).

## 5) Cost awareness

- Add explicit safety caps for fan-out jobs and background workers.
- Alarm on queue age/depth and error spikes.
- Use retention/TTL/lifecycle policies for telemetry and archives.
- Use least-size compute defaults and tune with measured load tests.

## 6) Failure handling and recovery

- Dead-letter queues for async workers.
- Circuit breaker for repeated remote failures.
- Explicit incident state transitions and dedupe windows for alerts.
- Runbooks for operational failure modes and rotation tasks.
