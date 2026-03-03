# NetPulse

NetPulse is a production-leaning, multi-tenant cloud infrastructure monitor built with Next.js, AWS Lambda, API Gateway, DynamoDB, and S3.

Portfolio pitch: I built a distributed uptime monitoring system similar to Datadog.

## Monorepo structure

- `apps/web`: Next.js dashboard (org overview, endpoint detail, incidents, live updates).
- `packages/shared`: Shared DTOs, Zod schemas, RBAC rules, API client.
- `services/authz`: JWT-claim and org-membership authorization helpers.
- `services/api`: REST and WebSocket Lambda handlers.
- `services/prober`: Scheduler, probe worker, notifier, WebSocket broadcaster, monthly exporter.
- `infra/cdk`: AWS CDK stack with Cognito, API Gateway, Lambda, DynamoDB, SQS, SNS, S3, EventBridge.

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
5. Synthesize CDK:
   - `npm run cdk:synth`
6. Run the web app:
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
  - Optional recruiter/demo GUI presets:
    - `NEXT_PUBLIC_DEFAULT_WORKSPACE_NAME`
    - `NEXT_PUBLIC_DEFAULT_ENDPOINT_NAME`
    - `NEXT_PUBLIC_DEFAULT_ENDPOINT_URL`
    - `NEXT_PUBLIC_TEST_ALERT_EMAIL`
    - `NEXT_PUBLIC_TEST_SLACK_WEBHOOK_URL`
    - `NEXT_PUBLIC_TEST_WEBHOOK_URL`
    - `NEXT_PUBLIC_SHOW_TESTING_HINTS=true`
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
