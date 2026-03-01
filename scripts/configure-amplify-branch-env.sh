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

Example:
  $(basename "$0") --env dev --app-id d123example --branch dev --profile netpulse-base --demo-org-id org_demo_public
USAGE
}

ENV_NAME=""
APP_ID=""
BRANCH_NAME=""
PROFILE=""
REGION="${AWS_REGION:-us-east-1}"
DEMO_ORG_ID="org_demo_public"
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
API_BASE_URL="${API_BASE_URL%/}"

if [ -z "$API_BASE_URL" ] || [ "$API_BASE_URL" = "None" ]; then
  echo "Could not resolve API URL from $STACK_NAME outputs" >&2
  exit 1
fi

ENV_JSON="$(jq -n \
  --arg api "$API_BASE_URL" \
  --arg ws "$WS_URL" \
  --arg pool "$COGNITO_USER_POOL_ID" \
  --arg client "$COGNITO_USER_POOL_CLIENT_ID" \
  --arg demo "$DEMO_ORG_ID" \
  '{
    NEXT_PUBLIC_API_BASE_URL: $api,
    NEXT_PUBLIC_WS_URL: $ws,
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: $pool,
    NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: $client,
    NEXT_PUBLIC_DEMO_ORG_ID: $demo
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
