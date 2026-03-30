#!/usr/bin/env bash

set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

ORG_ID="org_demo_public"
MIN_ENDPOINTS=1
API_CHECKS=()
FRONTEND_CHECKS=()

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [--org-id <org-id>] [--min-endpoints <count>]
                   [--api <label=url>]...
                   [--frontend <label=url>]...

Example:
  $(basename "$0") \
    --api staging=https://t5t1ojh1zj.execute-api.us-east-1.amazonaws.com \
    --frontend aws-staging=https://staging.dpl90cw6xnizn.amplifyapp.com
USAGE
}

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
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

json_request() {
  local url="$1"
  local tmp
  tmp="$(mktemp)"

  RESPONSE_STATUS="$(curl -sS -o "$tmp" -w "%{http_code}" "$url")"
  RESPONSE_BODY="$(cat "$tmp")"
  rm -f "$tmp"
}

text_request() {
  local url="$1"
  local tmp
  tmp="$(mktemp)"

  RESPONSE_STATUS="$(curl -sS -o "$tmp" -w "%{http_code}" "$url")"
  RESPONSE_BODY="$(cat "$tmp")"
  rm -f "$tmp"
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

while [ $# -gt 0 ]; do
  case "$1" in
    --org-id)
      ORG_ID="$2"
      shift 2
      ;;
    --min-endpoints)
      MIN_ENDPOINTS="$2"
      shift 2
      ;;
    --api)
      API_CHECKS+=("$(parse_check "$2")")
      shift 2
      ;;
    --frontend)
      FRONTEND_CHECKS+=("$(parse_check "$2")")
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

if [ "${#API_CHECKS[@]}" -eq 0 ] && [ "${#FRONTEND_CHECKS[@]}" -eq 0 ]; then
  echo "Provide at least one --api or --frontend check." >&2
  exit 1
fi

if ! [[ "$MIN_ENDPOINTS" =~ ^[0-9]+$ ]]; then
  echo "--min-endpoints must be a non-negative integer" >&2
  exit 1
fi

echo "=== Public demo smoke ($(timestamp)) ==="
echo "orgId=$ORG_ID minEndpoints=$MIN_ENDPOINTS"

for spec in "${API_CHECKS[@]}"; do
  label="${spec%%=*}"
  base_url="${spec#*=}"

  echo
  echo "[$label] API $base_url"

  json_request "$base_url/v1/public/organizations/$ORG_ID"
  assert_status 200 "$label get organization"
  echo "$RESPONSE_BODY" | jq -e --arg org_id "$ORG_ID" '.orgId == $org_id and .isActive == true' >/dev/null

  json_request "$base_url/v1/public/dashboard/summary?orgId=$ORG_ID&window=24h"
  assert_status 200 "$label dashboard summary"
  summary_total="$(echo "$RESPONSE_BODY" | jq -r '.totalEndpoints')"
  if [ "${summary_total:-0}" -lt "$MIN_ENDPOINTS" ]; then
    echo "[$label] expected at least $MIN_ENDPOINTS endpoints in summary, got $summary_total" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi

  json_request "$base_url/v1/public/endpoints?orgId=$ORG_ID&limit=20"
  assert_status 200 "$label list endpoints"
  endpoint_count="$(echo "$RESPONSE_BODY" | jq -r '.items | length')"
  if [ "${endpoint_count:-0}" -lt "$MIN_ENDPOINTS" ]; then
    echo "[$label] expected at least $MIN_ENDPOINTS endpoints, got $endpoint_count" >&2
    echo "$RESPONSE_BODY" >&2
    exit 1
  fi

  echo "[$label] ok (summaryEndpoints=$summary_total listedEndpoints=$endpoint_count)"
done

for spec in "${FRONTEND_CHECKS[@]}"; do
  label="${spec%%=*}"
  base_url="${spec#*=}"

  echo
  echo "[$label] Frontend $base_url"

  text_request "$base_url/org/$ORG_ID"
  assert_status 200 "$label frontend dashboard"
  if [[ "$RESPONSE_BODY" != *"NetPulse Operations Dashboard"* ]] && [[ "$RESPONSE_BODY" != *"$ORG_ID"* ]]; then
    echo "[$label] expected dashboard content for $ORG_ID" >&2
    exit 1
  fi

  echo "[$label] ok"
done

echo
echo "Public demo smoke passed."
