#!/usr/bin/env bash

set -euo pipefail

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") --env <dev|staging|prod> --app-id <AMPLIFY_APP_ID> --branch <BRANCH_NAME> [--profile <aws-profile>] [--region <aws-region>] [--demo-org-id <org_id>] [--dry-run]
               [--default-workspace-name <name>] [--default-endpoint-name <name>] [--default-endpoint-url <url>]
               [--test-alert-email <email>] [--test-slack-webhook-url <url>] [--test-webhook-url <url>] [--show-testing-hints <true|false>]
               [--grafana-dashboard-url <url>] [--prometheus-url <url>] [--aws-load-balancer-url <url>]
               [--gcp-load-balancer-url <url>] [--gcp-web-url <url>] [--load-balancer-health-path <path>]

Example:
  $(basename "$0") --env dev --app-id d123example --branch dev --profile netpulse-base --demo-org-id org_demo_public \\
    --test-alert-email recruiter@example.com --test-webhook-url https://webhook.site/replace-me --show-testing-hints true
USAGE
}

ENV_NAME=""
APP_ID=""
BRANCH_NAME=""
PROFILE=""
REGION="${AWS_REGION:-us-east-1}"
DEMO_ORG_ID="org_demo_public"
DEFAULT_WORKSPACE_NAME="Recruiter Sandbox Workspace"
DEFAULT_ENDPOINT_NAME="Recruiter Drill Endpoint"
DEFAULT_ENDPOINT_URL="https://example.com/health"
TEST_ALERT_EMAIL=""
TEST_SLACK_WEBHOOK_URL=""
TEST_WEBHOOK_URL=""
SHOW_TESTING_HINTS="false"
GRAFANA_DASHBOARD_URL=""
PROMETHEUS_URL=""
AWS_LOAD_BALANCER_URL=""
GCP_LOAD_BALANCER_URL=""
GCP_WEB_URL=""
LOAD_BALANCER_HEALTH_PATH="/healthz"
DRY_RUN="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENV_NAME="$2"
      shift 2
      ;;
    --app-id)
      APP_ID="$2"
      shift 2
      ;;
    --branch)
      BRANCH_NAME="$2"
      shift 2
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --demo-org-id)
      DEMO_ORG_ID="$2"
      shift 2
      ;;
    --default-workspace-name)
      DEFAULT_WORKSPACE_NAME="$2"
      shift 2
      ;;
    --default-endpoint-name)
      DEFAULT_ENDPOINT_NAME="$2"
      shift 2
      ;;
    --default-endpoint-url)
      DEFAULT_ENDPOINT_URL="$2"
      shift 2
      ;;
    --test-alert-email)
      TEST_ALERT_EMAIL="$2"
      shift 2
      ;;
    --test-slack-webhook-url)
      TEST_SLACK_WEBHOOK_URL="$2"
      shift 2
      ;;
    --test-webhook-url)
      TEST_WEBHOOK_URL="$2"
      shift 2
      ;;
    --show-testing-hints)
      SHOW_TESTING_HINTS="$2"
      shift 2
      ;;
    --grafana-dashboard-url)
      GRAFANA_DASHBOARD_URL="$2"
      shift 2
      ;;
    --prometheus-url)
      PROMETHEUS_URL="$2"
      shift 2
      ;;
    --aws-load-balancer-url)
      AWS_LOAD_BALANCER_URL="$2"
      shift 2
      ;;
    --gcp-load-balancer-url)
      GCP_LOAD_BALANCER_URL="$2"
      shift 2
      ;;
    --gcp-web-url)
      GCP_WEB_URL="$2"
      shift 2
      ;;
    --load-balancer-health-path)
      LOAD_BALANCER_HEALTH_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ -z "$ENV_NAME" ] || [ -z "$APP_ID" ] || [ -z "$BRANCH_NAME" ]; then
  usage
  exit 1
fi

if [ -z "$PROFILE" ]; then
  PROFILE="netpulse-$ENV_NAME"
fi

STACK_NAME="NetPulse-$ENV_NAME"

get_stack_output() {
  local key_fragment="$1"
  aws cloudformation describe-stacks \
    --region "$REGION" \
    --profile "$PROFILE" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?contains(OutputKey, \`${key_fragment}\`)].OutputValue | [0]" \
    --output text
}

API_BASE_URL="$(get_stack_output "NetPulseHttpApiUrl")"
WS_URL="$(get_stack_output "NetPulseWebSocketUrl")"
COGNITO_USER_POOL_ID="$(get_stack_output "NetPulseUserPoolId")"
COGNITO_USER_POOL_CLIENT_ID="$(get_stack_output "NetPulseUserPoolClientId")"
LOAD_BALANCER_URL="$(get_stack_output "NetPulseLoadBalancerUrl")"
API_BASE_URL="${API_BASE_URL%/}"
if [ "$LOAD_BALANCER_URL" = "None" ]; then
  LOAD_BALANCER_URL=""
fi
if [ -z "$AWS_LOAD_BALANCER_URL" ]; then
  AWS_LOAD_BALANCER_URL="$LOAD_BALANCER_URL"
fi

if [ -z "$API_BASE_URL" ] || [ "$API_BASE_URL" = "None" ]; then
  echo "Could not resolve API URL from $STACK_NAME outputs" >&2
  exit 1
fi

ENV_JSON="$(jq -n \
  --arg api "$API_BASE_URL" \
  --arg ws "$WS_URL" \
  --arg pool "$COGNITO_USER_POOL_ID" \
  --arg client "$COGNITO_USER_POOL_CLIENT_ID" \
  --arg lb "$LOAD_BALANCER_URL" \
  --arg awsLb "$AWS_LOAD_BALANCER_URL" \
  --arg gcpLb "$GCP_LOAD_BALANCER_URL" \
  --arg gcpWeb "$GCP_WEB_URL" \
  --arg lbHealthPath "$LOAD_BALANCER_HEALTH_PATH" \
  --arg grafana "$GRAFANA_DASHBOARD_URL" \
  --arg prometheus "$PROMETHEUS_URL" \
  --arg demo "$DEMO_ORG_ID" \
  --arg workspace "$DEFAULT_WORKSPACE_NAME" \
  --arg endpointName "$DEFAULT_ENDPOINT_NAME" \
  --arg endpointUrl "$DEFAULT_ENDPOINT_URL" \
  --arg testEmail "$TEST_ALERT_EMAIL" \
  --arg testSlack "$TEST_SLACK_WEBHOOK_URL" \
  --arg testWebhook "$TEST_WEBHOOK_URL" \
  --arg showHints "$SHOW_TESTING_HINTS" \
  '{
    NEXT_PUBLIC_API_BASE_URL: $api,
    NEXT_PUBLIC_WS_URL: $ws,
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: $pool,
    NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: $client,
    NEXT_PUBLIC_LOAD_BALANCER_URL: $lb,
    NEXT_PUBLIC_LOAD_BALANCER_HEALTH_PATH: $lbHealthPath,
    NEXT_PUBLIC_AWS_LOAD_BALANCER_URL: $awsLb,
    NEXT_PUBLIC_GCP_LOAD_BALANCER_URL: $gcpLb,
    NEXT_PUBLIC_GCP_WEB_URL: $gcpWeb,
    NEXT_PUBLIC_GRAFANA_DASHBOARD_URL: $grafana,
    NEXT_PUBLIC_PROMETHEUS_URL: $prometheus,
    NEXT_PUBLIC_DEMO_ORG_ID: $demo,
    NEXT_PUBLIC_DEFAULT_WORKSPACE_NAME: $workspace,
    NEXT_PUBLIC_DEFAULT_ENDPOINT_NAME: $endpointName,
    NEXT_PUBLIC_DEFAULT_ENDPOINT_URL: $endpointUrl,
    NEXT_PUBLIC_TEST_ALERT_EMAIL: $testEmail,
    NEXT_PUBLIC_TEST_SLACK_WEBHOOK_URL: $testSlack,
    NEXT_PUBLIC_TEST_WEBHOOK_URL: $testWebhook,
    NEXT_PUBLIC_SHOW_TESTING_HINTS: $showHints
  }')"

echo "Resolved environment values for $ENV_NAME:"
echo "$ENV_JSON" | jq

if [ "$DRY_RUN" = "true" ]; then
  echo "Dry run only. No Amplify update was applied."
  exit 0
fi

aws amplify get-branch \
  --region "$REGION" \
  --profile "$PROFILE" \
  --app-id "$APP_ID" \
  --branch-name "$BRANCH_NAME" >/dev/null

aws amplify update-branch \
  --region "$REGION" \
  --profile "$PROFILE" \
  --app-id "$APP_ID" \
  --branch-name "$BRANCH_NAME" \
  --environment-variables "$ENV_JSON" >/dev/null

echo "Amplify branch environment updated: app=$APP_ID branch=$BRANCH_NAME env=$ENV_NAME"
