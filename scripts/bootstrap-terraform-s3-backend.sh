#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [--bucket <bucket-name>] [--table <dynamodb-table>] [--region <aws-region>]
                   [--profile <aws-profile>] [--dry-run]
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

run_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [ "$DRY_RUN" != "true" ]; then
    "$@"
  fi
}

BUCKET=""
TABLE="netpulse-terraform-locks"
REGION="us-east-1"
PROFILE="netpulse-root"
DRY_RUN="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --bucket)
      BUCKET="$2"
      shift 2
      ;;
    --table)
      TABLE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --profile)
      PROFILE="$2"
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

require_cmd aws
require_cmd jq

ACCOUNT_ID="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"

if [ -z "$BUCKET" ]; then
  BUCKET="netpulse-terraform-state-${ACCOUNT_ID}-${REGION}"
fi

if ! aws s3api head-bucket --profile "$PROFILE" --bucket "$BUCKET" >/dev/null 2>&1; then
  if [ "$REGION" = "us-east-1" ]; then
    run_cmd aws s3api create-bucket --profile "$PROFILE" --bucket "$BUCKET"
  else
    run_cmd aws s3api create-bucket \
      --profile "$PROFILE" \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
fi

run_cmd aws s3api put-bucket-versioning \
  --profile "$PROFILE" \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

run_cmd aws s3api put-bucket-encryption \
  --profile "$PROFILE" \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

run_cmd aws s3api put-public-access-block \
  --profile "$PROFILE" \
  --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

if ! aws dynamodb describe-table --profile "$PROFILE" --region "$REGION" --table-name "$TABLE" >/dev/null 2>&1; then
  run_cmd aws dynamodb create-table \
    --profile "$PROFILE" \
    --region "$REGION" \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
fi

if [ "$DRY_RUN" != "true" ]; then
  aws dynamodb wait table-exists --profile "$PROFILE" --region "$REGION" --table-name "$TABLE"
fi

jq -n \
  --arg bucket "$BUCKET" \
  --arg table "$TABLE" \
  --arg region "$REGION" \
  --arg profile "$PROFILE" \
  '{
    bucket: $bucket,
    table: $table,
    region: $region,
    profile: $profile
  }'
