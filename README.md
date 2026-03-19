# NetPulse

NetPulse is a production-leaning, multi-tenant cloud infrastructure monitor built with Next.js, AWS Lambda, API Gateway, DynamoDB, and S3.

Portfolio pitch: I built a distributed uptime monitoring system similar to Datadog.

Portfolio highlights:

- "Implemented PgBouncer for advanced PostgreSQL connection pooling, preventing database connection exhaustion during simulated spikes of 10,000+ concurrent regional worker writes."
- "Enforced Zero-Trust architecture by establishing Mutual TLS (mTLS) encryption between distributed regional checkers and the centralized monitoring engine."

Multi-cloud note:

- AWS currently remains the authoritative control plane for auth, APIs, queueing, and persistence.
- Google Cloud Run can host the portable edge tier: demo backends, the service-discovered load balancer, and an optional web frontend pointed back at the AWS control plane.

## Monorepo structure

- `apps/web`: Next.js dashboard (org overview, endpoint detail, incidents, live updates).
- `packages/shared`: Shared DTOs, Zod schemas, RBAC rules, API client.
- `services/authz`: JWT-claim and org-membership authorization helpers.
- `services/api`: REST and WebSocket Lambda handlers.
- `services/prober`: Scheduler, probe worker, notifier, WebSocket broadcaster, monthly exporter.
- `services/load-balancer`: L7 proxy with dynamic service discovery, active health checks, circuit breaking, and Prometheus metrics.
- `infra/cdk`: AWS CDK stack with Cognito, API Gateway, Lambda, DynamoDB, SQS, SNS, S3, EventBridge.
- `infra/high-concurrency`: PgBouncer/PostgreSQL and mTLS queue drill assets for reliability stress testing.

## Implemented core flows

- Multi-tenant org + membership model with `Owner/Admin/Editor/Viewer` role checks.
- Self-service user registration with Cognito email verification plus password login.
- Endpoint CRUD (`HTTP/HTTPS`) and soft delete semantics.
- Scheduled probing every 5 minutes through EventBridge + SQS fan-out.
- Multi-region probe fan-out (`us-east-1`, `us-west-2`, `eu-west-1`, `ap-southeast-1`) per endpoint.
- Probe write path to DynamoDB with 90-day TTL.
- Incident lifecycle:
  - open on 2 consecutive failures.
  - resolve on first successful probe after open.
- Per-endpoint SLA target tracking with uptime/error-budget reporting.
- Failure simulation controls (`FORCE_FAIL`, `FORCE_DEGRADED`, `CLEAR`) for resilience drills.
- Live dashboard updates via WebSocket queue + broadcaster Lambda.
- Incident notifications via SNS email topic + Slack/webhook channels.
- Slack and webhook URLs are stored in AWS Secrets Manager (DynamoDB stores only secret ARNs).
- Alert deduplication window of 10 minutes via DynamoDB TTL table.
- WebSocket auth supports Cognito JWT verification (required by default outside `dev`).
- Lambda X-Ray tracing enabled across API/prober/notifier/exporter paths.
- API Gateway HTTP/WebSocket access logs with structured JSON fields in CloudWatch Logs.
- Monthly compressed CSV + manifest export to S3 for each org.
- Public demo read path at `/v1/public/*` for unauthenticated read-only portfolio access.
- Endpoint metrics include `p50/p95/p99` latency percentiles.

## Architecture signals

System pipeline:

```text
Event Scheduler -> Queue -> Worker Pool -> Metrics Store -> Dashboard
```

How this is implemented:

- Scale health checks:
  - EventBridge invokes `scheduler` every 5 minutes.
  - `scheduler` fans out endpoint-region jobs into SQS.
  - `worker` Lambdas process jobs concurrently and can scale horizontally with queue depth.
- Avoid duplicate alerts:
  - `notifier` claims a dedupe slot in DynamoDB (`alertDedupeTable`) with a TTL window.
  - duplicate notifications inside the dedupe window are dropped by conditional-write failure.
- Partition data:
  - probe results are written to DynamoDB with `probePk = orgId#endpointId` and sort key `timestampIso`.
  - incidents are partitioned by endpoint (`incidentPk = orgId#endpointId`) and indexed by org/state for dashboard reads.
  - endpoint records are partitioned by `orgId`, preserving tenant isolation and bounded org queries.

## Dynamic load balancing extension

`services/load-balancer` provides a dedicated request router for backend workloads:

- Dynamic service discovery:
  - `DISCOVERY_PROVIDER=consul|etcd|static`
  - Consul mode watches `/v1/health/service/{service}?passing=true`
  - etcd mode watches `/v3/kv/range` under `ETCD_KEY_PREFIX`
  - Routing table updates in-memory on every refresh; no restart required.
- Active health checks + circuit breaking:
  - each backend is health-checked on `HEALTH_CHECK_INTERVAL_MS`.
  - repeated failures trip an open circuit (`CIRCUIT_OPEN_AFTER_FAILURES`) and traffic is removed.
  - open circuits are periodically probed and automatically restored via half-open -> closed recovery.
- Observability pipeline:
  - Prometheus metrics endpoint on `/metrics`.
  - Core metrics include:
    - `netpulse_lb_active_connections`
    - `netpulse_lb_request_duration_seconds`
    - `netpulse_lb_upstream_5xx_total`
    - `netpulse_lb_backend_healthy`
    - `netpulse_lb_backend_circuit_state`

### Run with Consul discovery (local)

1. Start Consul:
   - `docker run --rm -p 8500:8500 -p 8600:8600/udp --name consul hashicorp/consul:1.20 agent -dev -client=0.0.0.0`
2. Start one or more backend instances that auto-register in Consul:
   - `CONSUL_URL=http://127.0.0.1:8500 BACKEND_PORT=3001 npm run dev:backend --workspace @netpulse/load-balancer`
   - `CONSUL_URL=http://127.0.0.1:8500 BACKEND_PORT=3002 npm run dev:backend --workspace @netpulse/load-balancer`
3. Start the load balancer:
   - `DISCOVERY_PROVIDER=consul CONSUL_URL=http://127.0.0.1:8500 CONSUL_SERVICE_NAME=netpulse-backend PORT=8080 npm run dev --workspace @netpulse/load-balancer`
4. Send traffic:
   - `curl http://127.0.0.1:8080/`
   - `curl http://127.0.0.1:8080/backends`

### Prometheus + Grafana dashboard

1. Start observability stack:
   - `docker compose -f infra/observability/docker-compose.yml up -d`
2. Open tools:
   - Prometheus: `http://localhost:9090`
   - Grafana: `http://localhost:3000` (admin/admin)
3. Open dashboard:
   - `NetPulse / NetPulse Load Balancer`

### Automated failure drill

1. Keep Consul, two demo backends, and the load balancer running locally.
2. Run:
   - `npm run drill:lb`
3. The drill will:
   - force one backend unhealthy (`/admin/failure-mode`),
   - drive traffic until circuit state flips to `OPEN`,
   - restore backend health,
   - wait for circuit state to return to `CLOSED`.

### ECS/Fargate deployment (CDK)

The CDK stack now provisions:

- dedicated VPC + ECS cluster for load-balancing workloads.
- Consul service (`np-consul-*`) in ECS.
- demo backend ECS service (`np-demo-backend-*`) auto-registering to Consul.
- NetPulse load balancer ECS service (`np-load-balancer-*`) discovering backends from Consul.
- internet-facing ALB exporting:
  - `NetPulseLoadBalancerDns-{env}`
  - `NetPulseLoadBalancerUrl-{env}`

### Google Cloud multi-cloud deployment (Cloud Run)

Phase 1 multi-cloud support deploys the portable runtime to Google Cloud while keeping the AWS control plane intact:

- two demo backends on Cloud Run.
- one Cloud Run load balancer using `DISCOVERY_PROVIDER=static` against those HTTPS backend URLs.
- one optional Cloud Run web frontend that points at AWS API Gateway, Cognito, WebSocket, and exposes both AWS and GCP runtime links in the UI.

Deploy:

- `npm run deploy:gcp:multicloud -- --env dev --project <gcp-project-id> --region us-central1`
- dry run without applying changes:
  - `npm run deploy:gcp:multicloud -- --env dev --project <gcp-project-id> --region us-central1 --dry-run`

More detail:

- `infra/gcp/README.md`

## Massive concurrency + zero-trust extension

This repo now includes an optional staging drill path for PostgreSQL burst writes and mTLS queue transport:

- PgBouncer connection pooling sits in front of PostgreSQL for write-spike simulation.
- A mutual-TLS queue drill enforces client-certificate auth for regional workers.

### PgBouncer spike drill (10k+ writes)

1. Start PostgreSQL + PgBouncer:
   - `docker compose -f infra/high-concurrency/docker-compose.yml up -d`
2. Run a spike test through PgBouncer:
   - `TOTAL_WRITES=10000 WRITE_CONCURRENCY=1000 npm run drill:pgbouncer`
3. Optional: increase beyond 10k writes:
   - `TOTAL_WRITES=25000 WRITE_CONCURRENCY=2000 npm run drill:pgbouncer`

### mTLS queue drill

1. Generate local CA/server/worker certificates:
   - `npm run certs:mtls`
2. Run the end-to-end mTLS drill:
   - `npm run drill:mtls`
   - optional burst tuning: `MTLS_WORKERS=200 MTLS_EVENTS_PER_WORKER=50 MTLS_CONNECT_CONCURRENCY=25 npm run drill:mtls`
3. The drill validates:
   - worker client cert is required (`rejectUnauthorized=true`)
   - encrypted TLS transport between regional workers and central queue endpoint
   - expected message delivery volume under concurrent worker fan-in

### Chaos Proof Pack drill (50% worker outage)

Run a scripted failure drill that kills half of active workers, replays unsent events, and writes a structured report:

- `MTLS_WORKERS=4 MTLS_EVENTS_PER_WORKER=2500 MTLS_KILL_RATIO=0.5 MTLS_KILL_AFTER_MS=1500 npm run drill:mtls:chaos`

Frontend evidence view:

- `/proof-pack` (or configure `NEXT_PUBLIC_PROOF_PACK_URL`)

## API surface (`/v1`)

- `POST /organizations`
- `GET /organizations/{orgId}`
- `POST /organizations/{orgId}/members`
- `PATCH /organizations/{orgId}/members/{memberId}`
- `POST /endpoints`
- `GET /endpoints`
- `GET /endpoints/{endpointId}`
- `PATCH /endpoints/{endpointId}`
- `DELETE /endpoints/{endpointId}`
- `GET /endpoints/{endpointId}/checks`
- `GET /endpoints/{endpointId}/metrics`
- `GET /endpoints/{endpointId}/sla`
- `POST /endpoints/{endpointId}/simulate`
- `GET /incidents`
- `POST /alert-channels/email`
- `POST /alert-channels/slack`
- `POST /alert-channels/webhook`
- `GET /dashboard/summary`

Public read-only API:

- `GET /v1/public/{proxy+}` (mapped to read-only handlers for demo org)

WebSocket routes:

- `subscribe`
- `unsubscribe`

## Local setup

1. Install dependencies:
   - `npm install`
2. Build all workspaces:
   - `npm run build`
3. Run tests:
   - `npm test`
4. Run type checks:
   - `npm run typecheck`
5. Run repo hygiene checks:
   - `npm run check:repo-hygiene`
6. Synthesize CDK:
   - `npm run cdk:synth`
7. Run the web app:
   - `npm run dev:web`

Web login uses Cognito `USER_PASSWORD_AUTH` (username/email + password), no manual JWT paste required.
Home page onboarding supports creating your first workspace immediately after sign-in.

## Deployment

Infrastructure stacks are defined for:

- `NetPulse-dev`
- `NetPulse-staging`
- `NetPulse-prod`

Deploy with:

- `npm run deploy:dev --workspace @netpulse/cdk`
- `npm run deploy:staging --workspace @netpulse/cdk`
- `npm run deploy:prod --workspace @netpulse/cdk`

## Operational scripts

- Smoke test all environments (auth + core API paths):
  - `./scripts/smoke-test-apis.sh --admin-profile netpulse-root`
- Production baseline regression gate (fails on missing auth/rate-limit/retry/logging-cost-failure controls):
  - `npm run prod:check`
- Full deployed dev integration (API + WS + notifier + incident lifecycle):
  - required env vars:
    - `DRILL_EMAIL_ADDRESS`
    - `DRILL_SLACK_WEBHOOK_URL`
    - `DRILL_WEBHOOK_RECEIVER_URL`
    - optional: `DRILL_WEBHOOK_SECRET_VALUE`
    - optional: `DRILL_SKIP_EMAIL_SUBSCRIPTION_CHECK=true` (use only when SNS email subscription is not confirmed yet)
  - `npm run test:integration:dev`
  - override profiles with: `tsx scripts/integration-dev-stack.ts --env dev --profile netpulse-dev --admin-profile netpulse-root --region us-east-1`
- Configure Amplify branch environment variables from stack outputs:
  - `./scripts/configure-amplify-branch-env.sh --env dev --app-id <AMPLIFY_APP_ID> --branch dev --profile netpulse-dev`
  - `./scripts/configure-amplify-branch-env.sh --env staging --app-id <AMPLIFY_APP_ID> --branch staging --profile netpulse-staging`
  - `./scripts/configure-amplify-branch-env.sh --env prod --app-id <AMPLIFY_APP_ID> --branch main --profile netpulse-prod`
  - include multi-cloud runtime URLs when available:
    - `--aws-load-balancer-url <aws-runtime-url>`
    - `--gcp-load-balancer-url <gcp-runtime-url>`
    - `--gcp-web-url <gcp-web-url>`
  - Optional recruiter/demo GUI presets:
    - `NEXT_PUBLIC_DEFAULT_WORKSPACE_NAME`
    - `NEXT_PUBLIC_DEFAULT_ENDPOINT_NAME`
    - `NEXT_PUBLIC_DEFAULT_ENDPOINT_URL`
    - `NEXT_PUBLIC_TEST_ALERT_EMAIL`
    - `NEXT_PUBLIC_TEST_SLACK_WEBHOOK_URL`
    - `NEXT_PUBLIC_TEST_WEBHOOK_URL`
    - `NEXT_PUBLIC_SHOW_TESTING_HINTS=true`
  - Optional load-balancer observability links in the frontend:
    - `NEXT_PUBLIC_LOAD_BALANCER_URL`
    - `NEXT_PUBLIC_GRAFANA_DASHBOARD_URL`
    - `NEXT_PUBLIC_PROMETHEUS_URL`
- Apply paid Webhook.site URLs end-to-end (Amplify env + local drill helper + optional release):
  - `./scripts/apply-paid-webhooksite.sh --slack-url <paid-url> --webhook-url <paid-url> --env prod --profile netpulse-root`
- Migrate away from root credentials to IAM user + role-assumed CDK deploy flow:
  - `./scripts/setup-iam-deployer.sh --bootstrap-profile netpulse-root --region us-east-1`
  - This script also patches the CDK deploy role to chain-assume file/image/lookup bootstrap roles, which is required for asset publishing with `netpulse-dev`.

## Defaults and assumptions

- AWS Region: `us-east-1`
- Probe interval: `5 minutes`
- Retention: `90 days` in DynamoDB + monthly S3 archive
- Per-org endpoint default cap: `2000`
- Dashboard windows: `24h`, `7d`, `30d`
- WebSocket unauthenticated mode: enabled in `dev`, disabled in `staging` and `prod`
- API public-demo mode: enabled in `dev`, disabled in `staging` and `prod`
- API rate limits (Lambda-side token bucket over DynamoDB):
  - public routes: `60` req/min/IP
  - authenticated routes: `300` req/min/user (non-prod), `600` req/min/user (prod)
- Scheduler cost guards:
  - max endpoints per org per cycle: `2000`
  - max probe jobs per cycle: `60000`

## Production baseline checklist

Use this baseline in all portfolio projects:

- Authentication: JWT verification at the edge (Cognito or equivalent), RBAC, strict tenant scoping.
- Rate limiting: API Gateway throttles + app-level limiter (DynamoDB/Redis token buckets).
- Retries + backoff: retry transient `429/5xx/timeouts` with bounded exponential backoff and jitter.
- Logging + tracing: structured logs with `requestId/correlationId/traceId`, X-Ray/OpenTelemetry traces.
- Cost awareness: guardrails on fan-out, queue depth alarms, concurrency limits, storage lifecycle policies.
- Failure handling: DLQs, idempotency keys, circuit breakers, incident state machine tests, runbooks.
