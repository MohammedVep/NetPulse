# AWS Cost Reduction Report

Date: 2026-04-03
Account: 194191749520
Region focus: us-east-1

## Summary

NetPulse had three categories of AWS cost action items:

1. historical spend that no longer maps to a live runtime surface
2. safe infrastructure defaults that were too expensive for non-prod
3. secret lifecycle gaps that could accumulate monthly storage charges

This change set addresses the safe infrastructure changes directly in code and leaves auditable evidence for the historical charges.

## Live audit findings

### App Runner

- March 2026 spend: `$62.58`
- Current live inventory check: no App Runner services found in the account regions that were scanned from the AWS CLI audit path
- Action: justified as historical spend, not an active NetPulse deployment target
- Target steady-state monthly cost for NetPulse App Runner: `$0`

### VPC endpoints

- March 2026 spend: `$63.76` in `VpcEndpoint-Hours`
- Current live inventory in `us-east-1`: no VPC endpoints returned from `describe-vpc-endpoints`
- Action: justified as historical or external-to-current-NetPulse spend; no live NetPulse endpoint deletion was required
- Target steady-state monthly cost for NetPulse VPC endpoints: `$0`

### DynamoDB

- March 2026 spend: `$134.09`
- Write request units: `$127.16`
- Action: reduce non-prod probe cadence and persist fewer healthy probe rows in non-prod
- Target monthly savings: `~$50-$70`

### ECS / Fargate

- March 2026 spend: `$39.73`
- Action: reduce non-prod steady-state demo backend capacity and schedule full stop/start windows for `dev` and `staging`
- Target monthly savings: `~$18-$20`

### CloudWatch

- March 2026 spend: `$35.88`
- Action: disable ECS container insights in non-prod, shorten API access-log retention in non-prod, and remove non-prod active tracing
- Target monthly savings: `~$8-$12`

### Secrets Manager

- March 2026 spend: `$22.81`
- Primary driver: per-secret storage, not API requests
- Action: future alert-channel secrets are now environment-scoped and tagged, plus a daily janitor deletes orphaned managed secrets after a grace window
- Target monthly savings: variable; approximately `$0.34` per stale secret removed per month in `us-east-1`

## Implemented changes

### Non-prod probe cost controls

- `dev` and `staging` probe schedule reduced from `5 minutes` to `15 minutes`
- non-prod worker now persists healthy probe result rows at most once per hour unless there is a state transition, simulation, or circuit-state change

### Non-prod runtime scheduling

- added a scale controller Lambda for `dev` and `staging`
- added timezone-aware schedules in `America/Toronto`
- start window: `08:00` Monday-Friday
- stop window: `20:00` Monday-Friday
- stop action disables the probe schedule before scaling ECS services to zero
- start action restores ECS desired counts and re-enables the probe schedule after services stabilize

### Observability cost controls

- non-prod Lambda tracing changed from active X-Ray to pass-through
- non-prod ECS container insights disabled
- non-prod API Gateway access-log retention shortened:
  - `dev`: `1 week`
  - `staging`: `2 weeks`

### Secret lifecycle controls

- new alert-channel secrets are created under `netpulse/{env}/{orgId}/{type}/{channelId}`
- new alert-channel secrets are tagged with environment, org, channel, and managed metadata
- added daily `secret-janitor` Lambda to remove orphaned managed secrets after a 24-hour grace period

## Operational note

App Runner and VPC endpoint charges were not acted on with destructive deletion because there was no live NetPulse resource to remove at the time of audit. That is the correct safe posture: do not delete from a billing line item alone when inventory is empty.

## Re-run the audit

```bash
npm run cost:audit -- --profile netpulse-root --region us-east-1 --start 2026-03-01 --end 2026-04-01
```
