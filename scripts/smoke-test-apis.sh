#!/usr/bin/env bash

set -euo pipefail

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

ENVIRONMENTS=()
ADMIN_PROFILE=""
REGION="${AWS_REGION:-us-east-1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-profile)
      ADMIN_PROFILE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    *)
      ENVIRONMENTS+=("$1")
      shift
      ;;
  esac
done

if [ "${#ENVIRONMENTS[@]}" -eq 0 ]; then
  ENVIRONMENTS=(dev staging prod)
fi

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

json_request() {
  local method="$1"
  local url="$2"
  local token="${3:-}"
  local body="${4:-}"

  local tmp
  tmp="$(mktemp)"

  local status
  if [ -n "$body" ]; then
    if [ -n "$token" ]; then
      status="$(curl -sS -o "$tmp" -w "%{http_code}" \
        -X "$method" \
        -H "content-type: application/json" \
        -H "authorization: Bearer $token" \
        --data "$body" \
        "$url")"
    else
      status="$(curl -sS -o "$tmp" -w "%{http_code}" \
        -X "$method" \
        -H "content-type: application/json" \
        --data "$body" \
        "$url")"
    fi
  else
    if [ -n "$token" ]; then
      status="$(curl -sS -o "$tmp" -w "%{http_code}" \
        -X "$method" \
        -H "authorization: Bearer $token" \
        "$url")"
    else
      status="$(curl -sS -o "$tmp" -w "%{http_code}" \
        -X "$method" \
        "$url")"
    fi
  fi

  RESPONSE_STATUS="$status"
  RESPONSE_BODY="$(cat "$tmp")"
  rm -f "$tmp"
}

get_stack_output() {
  local profile="$1"
  local stack_name="$2"
  local key_fragment="$3"

  aws cloudformation describe-stacks \
    --region "$REGION" \
    --profile "$profile" \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?contains(OutputKey, \`${key_fragment}\`)].OutputValue | [0]" \
    --output text
}

assert_status() {
  local expected="$1"
  local context="$2"
  if [ "$RESPONSE_STATUS" != "$expected" ]; then
    echo "[$context] expected HTTP $expected but got $RESPONSE_STATUS" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi
}

run_env_smoke() {
  local env="$1"
  local profile="netpulse-$env"
  local admin_profile="${ADMIN_PROFILE:-$profile}"
  local stack_name="NetPulse-$env"

  echo
  echo "=== Smoke test: $env ($(timestamp)) ==="

  local api_base
  local ws_url
  local user_pool_id
  local user_pool_client_id
  api_base="$(get_stack_output "$profile" "$stack_name" "NetPulseHttpApiUrl")"
  ws_url="$(get_stack_output "$profile" "$stack_name" "NetPulseWebSocketUrl")"
  user_pool_id="$(get_stack_output "$profile" "$stack_name" "NetPulseUserPoolId")"
  user_pool_client_id="$(get_stack_output "$profile" "$stack_name" "NetPulseUserPoolClientId")"
  api_base="${api_base%/}"

  if [ -z "$api_base" ] || [ "$api_base" = "None" ]; then
    echo "[$env] failed to resolve API URL from stack outputs" >&2
    exit 1
  fi

  echo "[$env] API: $api_base"
  echo "[$env] WS: $ws_url"

  json_request GET "$api_base/v1/endpoints?orgId=smoke" ""
  assert_status 401 "$env unauth"

  local username password token member_user_id member_email
  username="smoke-${env}-$(date -u +%s)-$RANDOM@example.com"
  password="Np!${env}$(date -u +%s)Aa1"

  aws cognito-idp admin-create-user \
    --region "$REGION" \
    --profile "$admin_profile" \
    --user-pool-id "$user_pool_id" \
    --username "$username" \
    --message-action SUPPRESS \
    --user-attributes Name=email,Value="$username" Name=email_verified,Value=true >/dev/null

  aws cognito-idp admin-set-user-password \
    --region "$REGION" \
    --profile "$admin_profile" \
    --user-pool-id "$user_pool_id" \
    --username "$username" \
    --password "$password" \
    --permanent >/dev/null

  token="$(aws cognito-idp initiate-auth \
    --region "$REGION" \
    --profile "$admin_profile" \
    --client-id "$user_pool_client_id" \
    --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters USERNAME="$username",PASSWORD="$password" \
    --query "AuthenticationResult.IdToken" \
    --output text)"

  if [ -z "$token" ] || [ "$token" = "None" ]; then
    echo "[$env] failed to obtain Cognito IdToken" >&2
    exit 1
  fi

  local org_name org_id endpoint_id
  org_name="Smoke ${env} $(date -u +%Y%m%dT%H%M%SZ)"

  json_request POST "$api_base/v1/organizations" "$token" \
    "{\"name\":\"$org_name\"}"
  assert_status 201 "$env create organization"
  org_id="$(echo "$RESPONSE_BODY" | jq -r ".orgId")"
  if [ -z "$org_id" ] || [ "$org_id" = "null" ]; then
    echo "[$env] create organization response missing orgId" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi

  json_request GET "$api_base/v1/organizations/$org_id" "$token"
  assert_status 200 "$env get organization"

  member_user_id="smoke-member-${env}-$(date -u +%s)"
  member_email="${member_user_id}@example.com"
  json_request POST "$api_base/v1/organizations/$org_id/members" "$token" \
    "{\"userId\":\"$member_user_id\",\"email\":\"$member_email\",\"role\":\"Viewer\",\"isActive\":true}"
  assert_status 201 "$env upsert member"

  json_request POST "$api_base/v1/endpoints" "$token" \
    "{\"orgId\":\"$org_id\",\"name\":\"Primary API\",\"url\":\"https://example.com/health\",\"timeoutMs\":6000,\"tags\":[\"smoke\",\"$env\"],\"checkRegions\":[\"us-east-1\",\"us-west-2\",\"eu-west-1\"],\"slaTargetPct\":99.9}"
  assert_status 201 "$env create endpoint"
  endpoint_id="$(echo "$RESPONSE_BODY" | jq -r ".endpointId")"
  if [ -z "$endpoint_id" ] || [ "$endpoint_id" = "null" ]; then
    echo "[$env] create endpoint response missing endpointId" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi

  json_request GET "$api_base/v1/endpoints?orgId=$org_id&limit=5" "$token"
  assert_status 200 "$env list endpoints"

  json_request GET "$api_base/v1/endpoints/$endpoint_id/metrics?window=24h" "$token"
  assert_status 200 "$env endpoint metrics"

  json_request GET "$api_base/v1/endpoints/$endpoint_id/sla?window=24h" "$token"
  assert_status 200 "$env endpoint sla"

  json_request POST "$api_base/v1/alert-channels/webhook" "$token" \
    "{\"orgId\":\"$org_id\",\"name\":\"Smoke Webhook\",\"url\":\"https://example.com/netpulse-webhook\",\"events\":[\"INCIDENT_OPEN\",\"INCIDENT_RESOLVED\"]}"
  assert_status 201 "$env webhook channel"

  json_request POST "$api_base/v1/endpoints/$endpoint_id/simulate" "$token" \
    "{\"mode\":\"FORCE_FAIL\",\"failureStatusCode\":503,\"durationMinutes\":5}"
  assert_status 200 "$env set simulation"

  json_request POST "$api_base/v1/endpoints/$endpoint_id/simulate" "$token" \
    "{\"mode\":\"CLEAR\"}"
  assert_status 200 "$env clear simulation"

  json_request GET "$api_base/v1/dashboard/summary?orgId=$org_id&window=24h" "$token"
  assert_status 200 "$env dashboard summary"

  json_request GET "$api_base/v1/ai/insights?orgId=$org_id&window=24h" "$token"
  assert_status 200 "$env ai insights"

  json_request GET "$api_base/v1/incidents?orgId=$org_id&status=open" "$token"
  assert_status 200 "$env incident list"

  json_request DELETE "$api_base/v1/endpoints/$endpoint_id" "$token"
  assert_status 204 "$env soft delete endpoint"

  aws cognito-idp admin-delete-user \
    --region "$REGION" \
    --profile "$admin_profile" \
    --user-pool-id "$user_pool_id" \
    --username "$username" >/dev/null

  echo "[$env] smoke test passed (orgId=$org_id endpointId=$endpoint_id)"
}

for env in "${ENVIRONMENTS[@]}"; do
  run_env_smoke "$env"
done

echo
echo "All smoke tests passed for: ${ENVIRONMENTS[*]}"
