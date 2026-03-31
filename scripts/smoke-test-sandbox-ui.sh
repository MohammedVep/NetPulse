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
GCP_REGION="${GCP_REGION:-us-central1}"
GCP_PROJECT_ID=""
ADMIN_PROFILE=""
USER_POOL_ID=""
USER_POOL_CLIENT_ID=""
API_BASE_URL=""
BROWSER_PROJECT="chromium"
FRONTEND_CHECKS=()
TEMP_USERNAME=""
TEMP_PASSWORD=""
ID_TOKEN=""
CREATED_ORG_IDS=()

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [--env <staging|prod>] [--region <aws-region>] [--admin-profile <profile>]
                   [--user-pool-id <id>] [--user-pool-client-id <id>] [--api-base-url <url>]
                   [--gcp-project <project-id>] [--gcp-region <gcp-region>]
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

default_gcp_project() {
  case "$1" in
    dev)
      printf '%s' "netpulse-multicloud-dev"
      ;;
    staging)
      printf '%s' "netpulse-multicloud-staging"
      ;;
    prod)
      printf '%s' "netpulse-multicloud-prod"
      ;;
    *)
      echo "Unsupported env for GCP project resolution: $1" >&2
      exit 1
      ;;
  esac
}

default_gcp_frontend_url() {
  case "$1" in
    staging)
      printf '%s' "https://np-web-staging-gcp-uknfwku4cq-uc.a.run.app"
      ;;
    prod)
      printf '%s' "https://np-web-prod-gcp-pdfdlgnxtq-uc.a.run.app"
      ;;
    *)
      echo "Unsupported env for GCP frontend fallback: $1" >&2
      exit 1
      ;;
  esac
}

resolve_gcp_frontend_url() {
  local env_name="$1"
  local fallback_url
  local project_id
  local service_name
  local resolved=""

  fallback_url="$(default_gcp_frontend_url "$env_name")"
  project_id="${GCP_PROJECT_ID:-$(default_gcp_project "$env_name")}"
  service_name="np-web-${env_name}-gcp"

  if command -v gcloud >/dev/null 2>&1; then
    resolved="$({
      gcloud run services describe "$service_name" \
        --project "$project_id" \
        --region "$GCP_REGION" \
        --format 'value(status.url)' 2>/dev/null || true
    })"
    resolved="$(trim_trailing_slash "$resolved")"
    if [ -n "$resolved" ]; then
      echo "Resolved GCP frontend for $env_name from Cloud Run: $resolved" >&2
      printf '%s' "$resolved"
      return
    fi
  fi

  echo "Using fallback GCP frontend for $env_name: $fallback_url" >&2
  printf '%s' "$fallback_url"
}

resolve_frontends() {
  if [ "${#FRONTEND_CHECKS[@]}" -gt 0 ]; then
    return
  fi

  case "$ENVIRONMENT" in
    staging)
      FRONTEND_CHECKS+=("aws-staging=https://staging.dpl90cw6xnizn.amplifyapp.com")
      FRONTEND_CHECKS+=("gcp-staging=$(resolve_gcp_frontend_url staging)")
      ;;
    prod)
      FRONTEND_CHECKS+=("aws-prod=https://main.dpl90cw6xnizn.amplifyapp.com")
      FRONTEND_CHECKS+=("gcp-prod=$(resolve_gcp_frontend_url prod)")
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

authenticate_temp_user() {
  local client_id="$1"
  local username="$2"
  local password="$3"
  local attempt
  local token=""

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    token="$({
      aws_cmd cognito-idp initiate-auth \
        --client-id "$client_id" \
        --auth-flow USER_PASSWORD_AUTH \
        --auth-parameters "USERNAME=$username,PASSWORD=$password" \
        --query 'AuthenticationResult.IdToken' \
        --output text 2>/dev/null || true
    })"

    if [ -n "$token" ] && [ "$token" != "None" ]; then
      printf '%s' "$token"
      return 0
    fi

    sleep 2
  done

  echo "Failed to authenticate temporary smoke user via Cognito" >&2
  exit 1
}

delete_sandbox_org_request() {
  local org_id="$1"
  local tmp
  tmp="$(mktemp)"

  RESPONSE_STATUS="$({
    curl -sS -o "$tmp" -w "%{http_code}" \
      -X DELETE \
      -H "authorization: Bearer $ID_TOKEN" \
      -H "content-type: application/json" \
      "$API_BASE_URL/v1/organizations/$org_id/sandbox"
  })"
  RESPONSE_BODY="$(cat "$tmp")"
  rm -f "$tmp"
}

remove_created_org() {
  local org_id="$1"
  local remaining=()
  local existing

  for existing in "${CREATED_ORG_IDS[@]}"; do
    if [ "$existing" != "$org_id" ]; then
      remaining+=("$existing")
    fi
  done

  if [ "${#remaining[@]}" -eq 0 ]; then
    CREATED_ORG_IDS=()
  else
    CREATED_ORG_IDS=("${remaining[@]}")
  fi
}

cleanup_sandbox_org() {
  local org_id="$1"
  delete_sandbox_org_request "$org_id"
  if [ "$RESPONSE_STATUS" != "200" ]; then
    echo "[cleanup:$org_id] expected HTTP 200 but got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi

  echo "Cleaned sandbox org $org_id"
  remove_created_org "$org_id"
}

cleanup() {
  local org_id

  if [ "${#CREATED_ORG_IDS[@]}" -gt 0 ]; then
    for org_id in "${CREATED_ORG_IDS[@]}"; do
      if [ -n "$org_id" ] && [ -n "$API_BASE_URL" ] && [ -n "$ID_TOKEN" ]; then
        delete_sandbox_org_request "$org_id" >/dev/null 2>&1 || true
      fi
    done
  fi

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
    --user-pool-client-id)
      USER_POOL_CLIENT_ID="$2"
      shift 2
      ;;
    --api-base-url)
      API_BASE_URL="$(trim_trailing_slash "$2")"
      shift 2
      ;;
    --gcp-project)
      GCP_PROJECT_ID="$2"
      shift 2
      ;;
    --gcp-region)
      GCP_REGION="$2"
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
if [ -z "$USER_POOL_CLIENT_ID" ]; then
  USER_POOL_CLIENT_ID="$(resolve_export "NetPulseUserPoolClientId-$ENVIRONMENT")"
fi
if [ -z "$API_BASE_URL" ]; then
  API_BASE_URL="$(trim_trailing_slash "$(resolve_export "NetPulseHttpApiUrl-$ENVIRONMENT")")"
fi

TEMP_USERNAME="playwright-${ENVIRONMENT}-$(date -u +%s)-$RANDOM@example.com"
TEMP_PASSWORD="Np!${ENVIRONMENT}$(date -u +%s)Aa1"
trap cleanup EXIT
create_temp_user "$USER_POOL_ID" "$TEMP_USERNAME" "$TEMP_PASSWORD"
ID_TOKEN="$(authenticate_temp_user "$USER_POOL_CLIENT_ID" "$TEMP_USERNAME" "$TEMP_PASSWORD")"

for spec in "${FRONTEND_CHECKS[@]}"; do
  label="${spec%%=*}"
  base_url="${spec#*=}"
  run_log="$(mktemp)"

  echo "=== Playwright sandbox smoke [$label] $base_url ==="
  if ! PLAYWRIGHT_BASE_URL="$base_url" \
    PLAYWRIGHT_SMOKE_EMAIL="$TEMP_USERNAME" \
    PLAYWRIGHT_SMOKE_PASSWORD="$TEMP_PASSWORD" \
    PLAYWRIGHT_SMOKE_ENDPOINT_NAME="Playwright ${ENVIRONMENT} ${label}" \
    PLAYWRIGHT_SMOKE_ENDPOINT_URL="https://example.com/${ENVIRONMENT}/${label}/health" \
    npx playwright test tests/playwright/demo-sandbox.spec.ts --project="$BROWSER_PROJECT" 2>&1 | tee "$run_log"; then
    rm -f "$run_log"
    exit 1
  fi

  sandbox_org_id="$(grep -Eo 'SANDBOX_ORG_ID=org_[A-Za-z0-9_-]+' "$run_log" | tail -1 | cut -d= -f2)"
  rm -f "$run_log"

  if [ -z "$sandbox_org_id" ]; then
    echo "Failed to capture sandbox org id from Playwright output" >&2
    exit 1
  fi

  CREATED_ORG_IDS+=("$sandbox_org_id")
  cleanup_sandbox_org "$sandbox_org_id"
done

echo
echo "Sandbox UI smoke passed for env=$ENVIRONMENT"
