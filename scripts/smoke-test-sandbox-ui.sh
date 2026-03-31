#!/usr/bin/env bash

set -euo pipefail

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required" >&2
  exit 1
fi

ENVIRONMENT="staging"
REGION="${AWS_REGION:-us-east-1}"
ADMIN_PROFILE=""
USER_POOL_ID=""
BROWSER_PROJECT="chromium"
FRONTEND_CHECKS=()
TEMP_USERNAME=""

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [--env <staging|prod>] [--region <aws-region>] [--admin-profile <profile>]
                   [--user-pool-id <id>]
                   [--frontend <label=url>]... [--browser <project>]

Examples:
  $(basename "$0") --env staging
  $(basename "$0") --env staging --frontend aws=https://staging.dpl90cw6xnizn.amplifyapp.com
USAGE
}

trim_trailing_slash() {
  local value="${1:-}"
  printf '%s' "${value%/}"
}

parse_check() {
  local raw="$1"
  if [[ "$raw" != *=* ]]; then
    echo "Expected label=url, got: $raw" >&2
    exit 1
  fi

  local label="${raw%%=*}"
  local url="${raw#*=}"
  if [ -z "$label" ] || [ -z "$url" ]; then
    echo "Invalid check spec: $raw" >&2
    exit 1
  fi

  printf '%s=%s' "$label" "$(trim_trailing_slash "$url")"
}

aws_cmd() {
  local args=()
  if [ -n "$ADMIN_PROFILE" ]; then
    args+=(--profile "$ADMIN_PROFILE")
  fi
  aws "${args[@]}" --region "$REGION" "$@"
}

resolve_frontends() {
  if [ "${#FRONTEND_CHECKS[@]}" -gt 0 ]; then
    return
  fi

  case "$ENVIRONMENT" in
    staging)
      FRONTEND_CHECKS+=("aws-staging=https://staging.dpl90cw6xnizn.amplifyapp.com")
      FRONTEND_CHECKS+=("gcp-staging=https://np-web-staging-gcp-uknfwku4cq-uc.a.run.app")
      ;;
    prod)
      FRONTEND_CHECKS+=("aws-prod=https://main.dpl90cw6xnizn.amplifyapp.com")
      FRONTEND_CHECKS+=("gcp-prod=https://np-web-prod-gcp-pdfdlgnxtq-uc.a.run.app")
      ;;
    *)
      echo "Unsupported env: $ENVIRONMENT" >&2
      exit 1
      ;;
  esac
}

resolve_export() {
  local export_name="$1"
  local value
  value="$(aws_cmd cloudformation list-exports \
    --query "Exports[?Name=='$export_name'].Value | [0]" \
    --output text)"

  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "Failed to resolve CloudFormation export: $export_name" >&2
    exit 1
  fi

  printf '%s' "$value"
}

create_temp_user() {
  local user_pool_id="$1"
  local username="$2"
  local password="$3"

  aws_cmd cognito-idp admin-create-user \
    --user-pool-id "$user_pool_id" \
    --username "$username" \
    --message-action SUPPRESS \
    --user-attributes Name=email,Value="$username" Name=email_verified,Value=true >/dev/null

  aws_cmd cognito-idp admin-set-user-password \
    --user-pool-id "$user_pool_id" \
    --username "$username" \
    --password "$password" \
    --permanent >/dev/null
}

cleanup() {
  if [ -n "$TEMP_USERNAME" ] && [ -n "$USER_POOL_ID" ]; then
    aws_cmd cognito-idp admin-delete-user \
      --user-pool-id "$USER_POOL_ID" \
      --username "$TEMP_USERNAME" >/dev/null 2>&1 || true
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --admin-profile)
      ADMIN_PROFILE="$2"
      shift 2
      ;;
    --user-pool-id)
      USER_POOL_ID="$2"
      shift 2
      ;;
    --frontend)
      FRONTEND_CHECKS+=("$(parse_check "$2")")
      shift 2
      ;;
    --browser)
      BROWSER_PROJECT="$2"
      shift 2
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

resolve_frontends

if [ -z "$USER_POOL_ID" ]; then
  USER_POOL_ID="$(resolve_export "NetPulseUserPoolId-$ENVIRONMENT")"
fi

TEMP_USERNAME="playwright-${ENVIRONMENT}-$(date -u +%s)-$RANDOM@example.com"
TEMP_PASSWORD="Np!${ENVIRONMENT}$(date -u +%s)Aa1"
trap cleanup EXIT
create_temp_user "$USER_POOL_ID" "$TEMP_USERNAME" "$TEMP_PASSWORD"

for spec in "${FRONTEND_CHECKS[@]}"; do
  label="${spec%%=*}"
  base_url="${spec#*=}"

  echo "=== Playwright sandbox smoke [$label] $base_url ==="
  PLAYWRIGHT_BASE_URL="$base_url" \
  PLAYWRIGHT_SMOKE_EMAIL="$TEMP_USERNAME" \
  PLAYWRIGHT_SMOKE_PASSWORD="$TEMP_PASSWORD" \
  PLAYWRIGHT_SMOKE_ENDPOINT_NAME="Playwright ${ENVIRONMENT} ${label}" \
  PLAYWRIGHT_SMOKE_ENDPOINT_URL="https://example.com/${ENVIRONMENT}/${label}/health" \
  npx playwright test tests/playwright/demo-sandbox.spec.ts --project="$BROWSER_PROJECT"
done

echo
echo "Sandbox UI smoke passed for env=$ENVIRONMENT"
