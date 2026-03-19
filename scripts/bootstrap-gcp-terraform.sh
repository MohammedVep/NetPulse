#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") --env <dev|staging|prod> --project <gcp-project-id> [--project-name <name>]
               [--billing-account <billing-account-id>] [--region <gcp-region>] [--artifact-region <gcp-region>]
               [--repository <artifact-registry-repo>] [--terraform-dir <dir>]
               [--backend-bucket <s3-bucket>] [--backend-table <dynamodb-table>] [--backend-region <aws-region>]
               [--backend-profile <aws-profile>] [--skip-backend-bootstrap] [--dry-run]
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

cleanup() {
  if [ -n "${TEMP_TF_DATA_DIR:-}" ] && [ -d "${TEMP_TF_DATA_DIR:-}" ]; then
    rm -rf "$TEMP_TF_DATA_DIR"
  fi
}

tf_cmd() {
  terraform -chdir="$TERRAFORM_DIR" "$@"
}

state_has() {
  tf_cmd state show "$1" >/dev/null 2>&1
}

project_exists() {
  gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1
}

env_display_name() {
  case "$1" in
    dev)
      echo "Dev"
      ;;
    staging)
      echo "Staging"
      ;;
    prod)
      echo "Prod"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

repository_exists() {
  gcloud artifacts repositories describe "$REPOSITORY" \
    --project "$PROJECT_ID" \
    --location "$ARTIFACT_REGION" >/dev/null 2>&1
}

service_enabled() {
  gcloud services list \
    --enabled \
    --project "$PROJECT_ID" \
    --filter="config.name=$1" \
    --format='value(config.name)' | grep -qx "$1"
}

wait_for_project() {
  local attempts=0
  while [ "$attempts" -lt 30 ]; do
    if project_exists; then
      return 0
    fi
    sleep 2
    attempts=$((attempts + 1))
  done

  echo "Timed out waiting for project $PROJECT_ID to become visible." >&2
  exit 1
}

remote_state_key() {
  printf 'infra/gcp/%s.tfstate' "$ENV_NAME"
}

local_state_path() {
  printf '%s/terraform.tfstate.d/%s/terraform.tfstate' "$TERRAFORM_DIR_ABS" "$ENV_NAME"
}

remote_state_exists() {
  aws s3api head-object \
    --profile "$BACKEND_PROFILE" \
    --region "$BACKEND_REGION" \
    --bucket "$BACKEND_BUCKET" \
    --key "$(remote_state_key)" >/dev/null 2>&1
}

ENV_NAME=""
PROJECT_ID=""
PROJECT_NAME=""
BILLING_ACCOUNT=""
REGION="us-central1"
ARTIFACT_REGION=""
REPOSITORY="netpulse"
TERRAFORM_DIR="infra/gcp"
BACKEND_BUCKET=""
BACKEND_TABLE="netpulse-terraform-locks"
BACKEND_REGION="us-east-1"
BACKEND_PROFILE="netpulse-root"
SKIP_BACKEND_BOOTSTRAP="false"
DRY_RUN="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENV_NAME="$2"
      shift 2
      ;;
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --project-name)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --billing-account)
      BILLING_ACCOUNT="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --artifact-region)
      ARTIFACT_REGION="$2"
      shift 2
      ;;
    --repository)
      REPOSITORY="$2"
      shift 2
      ;;
    --terraform-dir)
      TERRAFORM_DIR="$2"
      shift 2
      ;;
    --backend-bucket)
      BACKEND_BUCKET="$2"
      shift 2
      ;;
    --backend-table)
      BACKEND_TABLE="$2"
      shift 2
      ;;
    --backend-region)
      BACKEND_REGION="$2"
      shift 2
      ;;
    --backend-profile)
      BACKEND_PROFILE="$2"
      shift 2
      ;;
    --skip-backend-bootstrap)
      SKIP_BACKEND_BOOTSTRAP="true"
      shift
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

if [ -z "$ENV_NAME" ] || [ -z "$PROJECT_ID" ]; then
  usage
  exit 1
fi

case "$ENV_NAME" in
  dev|staging|prod)
    ;;
  *)
    echo "--env must be one of dev|staging|prod" >&2
    exit 1
    ;;
esac

if [ -z "$ARTIFACT_REGION" ]; then
  ARTIFACT_REGION="$REGION"
fi

if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME="NetPulse Multicloud $(env_display_name "$ENV_NAME")"
fi

TERRAFORM_DIR_ABS="$(cd "$TERRAFORM_DIR" && pwd)"

require_cmd terraform
require_cmd gcloud
require_cmd jq
require_cmd aws

TEMP_TF_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/netpulse-gcp-tf-${ENV_NAME}.XXXXXX")"
export TF_DATA_DIR="$TEMP_TF_DATA_DIR"
unset TF_WORKSPACE || true
trap cleanup EXIT

if [ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]; then
  GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
  export GOOGLE_OAUTH_ACCESS_TOKEN
fi

AWS_ACCOUNT_ID="$(aws sts get-caller-identity --profile "$BACKEND_PROFILE" --query Account --output text)"

if [ -z "$BACKEND_BUCKET" ]; then
  BACKEND_BUCKET="netpulse-terraform-state-${AWS_ACCOUNT_ID}-${BACKEND_REGION}"
fi

if [ -z "$BILLING_ACCOUNT" ]; then
  BILLING_ACCOUNT="$(gcloud billing accounts list --filter='open=true' --format='value(name)' | head -n 1)"
fi

if [ -z "$BILLING_ACCOUNT" ]; then
  echo "Could not resolve an open billing account. Pass --billing-account explicitly." >&2
  exit 1
fi

TF_VAR_ARGS=(
  -var "env_name=$ENV_NAME"
  -var "project_id=$PROJECT_ID"
  -var "project_name=$PROJECT_NAME"
  -var "billing_account=$BILLING_ACCOUNT"
  -var "region=$REGION"
  -var "artifact_region=$ARTIFACT_REGION"
  -var "repository=$REPOSITORY"
)

MANAGED_SERVICES=(
  cloudresourcemanager.googleapis.com
  serviceusage.googleapis.com
  artifactregistry.googleapis.com
  run.googleapis.com
)

PREREQ_SERVICES=(
  cloudresourcemanager.googleapis.com
  serviceusage.googleapis.com
)

TF_ARGS=(
  -input=false
  "${TF_VAR_ARGS[@]}"
)

if [ "$SKIP_BACKEND_BOOTSTRAP" != "true" ]; then
  BACKEND_CMD=(
    bash
    scripts/bootstrap-terraform-s3-backend.sh
    --bucket "$BACKEND_BUCKET"
    --table "$BACKEND_TABLE"
    --region "$BACKEND_REGION"
    --profile "$BACKEND_PROFILE"
  )

  if [ "$DRY_RUN" = "true" ]; then
    BACKEND_CMD+=(--dry-run)
  fi

  run_cmd "${BACKEND_CMD[@]}"
fi

INIT_ARGS=(
  init
  -input=false
  -reconfigure
  -backend-config="bucket=$BACKEND_BUCKET"
  -backend-config="key=$(remote_state_key)"
  -backend-config="region=$BACKEND_REGION"
  -backend-config="dynamodb_table=$BACKEND_TABLE"
  -backend-config="encrypt=true"
  -backend-config="profile=$BACKEND_PROFILE"
)

run_cmd tf_cmd "${INIT_ARGS[@]}"

LOCAL_STATE_PATH="$(local_state_path)"
if [ "$DRY_RUN" != "true" ] && [ -s "$LOCAL_STATE_PATH" ] && ! remote_state_exists; then
  run_cmd tf_cmd state push -force "$LOCAL_STATE_PATH"
fi

if [ "$DRY_RUN" != "true" ]; then
  if project_exists; then
    tf_cmd untaint google_project.netpulse >/dev/null 2>&1 || true
    if ! state_has google_project.netpulse; then
      run_cmd tf_cmd import "${TF_VAR_ARGS[@]}" google_project.netpulse "$PROJECT_ID"
    fi
  else
    run_cmd tf_cmd apply -auto-approve "${TF_ARGS[@]}" -target=google_project.netpulse
    wait_for_project
  fi

  run_cmd gcloud services enable "${PREREQ_SERVICES[@]}" --project "$PROJECT_ID"

  for service in "${MANAGED_SERVICES[@]}"; do
    if service_enabled "$service" && ! state_has "google_project_service.services[\"$service\"]"; then
      run_cmd tf_cmd import "${TF_VAR_ARGS[@]}" "google_project_service.services[\"$service\"]" "$PROJECT_ID/$service"
    fi
  done

  if repository_exists && ! state_has google_artifact_registry_repository.containers; then
    run_cmd tf_cmd import "${TF_VAR_ARGS[@]}" google_artifact_registry_repository.containers \
      "projects/$PROJECT_ID/locations/$ARTIFACT_REGION/repositories/$REPOSITORY"
  fi
fi

if [ "$DRY_RUN" = "true" ]; then
  run_cmd tf_cmd plan "${TF_ARGS[@]}"
else
  run_cmd tf_cmd apply -auto-approve "${TF_ARGS[@]}"
  tf_cmd output -json
fi
