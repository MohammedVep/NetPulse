#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") --env <dev|staging|prod> --project <gcp-project-id> [--region <gcp-region>] [--artifact-region <gcp-region>]
               [--repository <artifact-registry-repo>] [--aws-profile <aws-profile>] [--aws-region <aws-region>]
               [--api-base-url <aws-api-url>] [--ws-url <aws-websocket-url>]
               [--cognito-user-pool-id <pool-id>] [--cognito-user-pool-client-id <client-id>]
               [--aws-load-balancer-url <aws-runtime-url>] [--grafana-dashboard-url <url>] [--prometheus-url <url>]
               [--demo-org-id <org-id>] [--default-workspace-name <name>] [--default-endpoint-name <name>]
               [--default-endpoint-url <url>] [--dry-run]

Examples:
  $(basename "$0") --env dev --project my-netpulse --region us-central1
  $(basename "$0") --env dev --project my-netpulse --region us-central1 --dry-run
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

run_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [ "$DRY_RUN" != "true" ]; then
    "$@"
  fi
}

build_and_push_image() {
  local dockerfile="$1"
  local image="$2"
  shift 2

  run_cmd docker buildx build \
    --platform linux/amd64 \
    -f "$dockerfile" \
    -t "$image" \
    "$@" \
    --push \
    .
}

trim_trailing_slash() {
  local value="${1:-}"
  printf '%s' "${value%/}"
}

env_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

write_env_file() {
  local file="$1"
  shift
  : >"$file"
  while [ "$#" -gt 1 ]; do
    local key="$1"
    local value="$2"
    shift 2
    printf '%s=%s\n' "$key" "$(env_quote "$value")" >>"$file"
  done
}

describe_service_url() {
  local service_name="$1"
  gcloud run services describe "$service_name" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --format 'value(status.url)'
}

placeholder_url() {
  local service_name="$1"
  printf 'https://%s.run.app' "$service_name"
}

get_stack_output() {
  local key_fragment="$1"
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?contains(OutputKey, \`${key_fragment}\`)].OutputValue | [0]" \
    --output text
}

ENV_NAME=""
PROJECT_ID=""
REGION="us-central1"
ARTIFACT_REGION=""
REPOSITORY="netpulse"
AWS_PROFILE=""
AWS_REGION="${AWS_REGION:-us-east-1}"
API_BASE_URL=""
WS_URL=""
COGNITO_USER_POOL_ID=""
COGNITO_USER_POOL_CLIENT_ID=""
AWS_LOAD_BALANCER_URL=""
GRAFANA_DASHBOARD_URL=""
PROMETHEUS_URL=""
DEMO_ORG_ID="org_demo_public"
DEFAULT_WORKSPACE_NAME="Recruiter Sandbox Workspace"
DEFAULT_ENDPOINT_NAME="Recruiter Drill Endpoint"
DEFAULT_ENDPOINT_URL="https://example.com/health"
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
    --aws-profile)
      AWS_PROFILE="$2"
      shift 2
      ;;
    --aws-region)
      AWS_REGION="$2"
      shift 2
      ;;
    --api-base-url)
      API_BASE_URL="$2"
      shift 2
      ;;
    --ws-url)
      WS_URL="$2"
      shift 2
      ;;
    --cognito-user-pool-id)
      COGNITO_USER_POOL_ID="$2"
      shift 2
      ;;
    --cognito-user-pool-client-id)
      COGNITO_USER_POOL_CLIENT_ID="$2"
      shift 2
      ;;
    --aws-load-balancer-url)
      AWS_LOAD_BALANCER_URL="$2"
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

if [ -z "$AWS_PROFILE" ]; then
  AWS_PROFILE="netpulse-$ENV_NAME"
fi

STACK_NAME="NetPulse-$ENV_NAME"
REGISTRY_HOST="${ARTIFACT_REGION}-docker.pkg.dev"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
if [ -z "$GIT_SHA" ]; then
  GIT_SHA="$(date -u +%Y%m%d%H%M%SZ)"
fi
IMAGE_TAG="${ENV_NAME}-${GIT_SHA}"

BACKEND_IMAGE="${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}/demo-backend:${IMAGE_TAG}"
LOAD_BALANCER_IMAGE="${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}/load-balancer:${IMAGE_TAG}"
WEB_IMAGE="${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}/web:${IMAGE_TAG}"

BACKEND_A_SERVICE="np-demo-backend-a-${ENV_NAME}-gcp"
BACKEND_B_SERVICE="np-demo-backend-b-${ENV_NAME}-gcp"
LOAD_BALANCER_SERVICE="np-load-balancer-${ENV_NAME}-gcp"
WEB_SERVICE="np-web-${ENV_NAME}-gcp"

require_cmd aws
require_cmd jq
require_cmd docker

if [ "$DRY_RUN" != "true" ]; then
  require_cmd gcloud
fi

if [ -z "$API_BASE_URL" ]; then
  API_BASE_URL="$(get_stack_output "NetPulseHttpApiUrl")"
fi
if [ -z "$WS_URL" ]; then
  WS_URL="$(get_stack_output "NetPulseWebSocketUrl")"
fi
if [ -z "$COGNITO_USER_POOL_ID" ]; then
  COGNITO_USER_POOL_ID="$(get_stack_output "NetPulseUserPoolId")"
fi
if [ -z "$COGNITO_USER_POOL_CLIENT_ID" ]; then
  COGNITO_USER_POOL_CLIENT_ID="$(get_stack_output "NetPulseUserPoolClientId")"
fi
if [ -z "$AWS_LOAD_BALANCER_URL" ]; then
  AWS_LOAD_BALANCER_URL="$(get_stack_output "NetPulseLoadBalancerUrl")"
fi

API_BASE_URL="$(trim_trailing_slash "$API_BASE_URL")"
AWS_LOAD_BALANCER_URL="$(trim_trailing_slash "$AWS_LOAD_BALANCER_URL")"

if [ -z "$API_BASE_URL" ] || [ "$API_BASE_URL" = "None" ]; then
  echo "Could not resolve API URL from $STACK_NAME outputs" >&2
  exit 1
fi

if [ "$WS_URL" = "None" ]; then
  WS_URL=""
fi
if [ "$COGNITO_USER_POOL_ID" = "None" ]; then
  COGNITO_USER_POOL_ID=""
fi
if [ "$COGNITO_USER_POOL_CLIENT_ID" = "None" ]; then
  COGNITO_USER_POOL_CLIENT_ID=""
fi
if [ "$AWS_LOAD_BALANCER_URL" = "None" ]; then
  AWS_LOAD_BALANCER_URL=""
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

BACKEND_A_ENV_FILE="$TEMP_DIR/backend-a.env"
BACKEND_B_ENV_FILE="$TEMP_DIR/backend-b.env"
LOAD_BALANCER_ENV_FILE="$TEMP_DIR/load-balancer.env"
WEB_ENV_FILE="$TEMP_DIR/web.env"

write_env_file "$BACKEND_A_ENV_FILE" \
  BACKEND_ID "$BACKEND_A_SERVICE" \
  CONSUL_AUTO_REGISTER "false"

write_env_file "$BACKEND_B_ENV_FILE" \
  BACKEND_ID "$BACKEND_B_SERVICE" \
  CONSUL_AUTO_REGISTER "false"

log "Resolved AWS control plane inputs"
jq -n \
  --arg env "$ENV_NAME" \
  --arg project "$PROJECT_ID" \
  --arg region "$REGION" \
  --arg api "$API_BASE_URL" \
  --arg ws "$WS_URL" \
  --arg pool "$COGNITO_USER_POOL_ID" \
  --arg client "$COGNITO_USER_POOL_CLIENT_ID" \
  --arg awsLb "$AWS_LOAD_BALANCER_URL" \
  '{
    env: $env,
    project: $project,
    region: $region,
    apiBaseUrl: $api,
    wsUrl: $ws,
    cognitoUserPoolId: $pool,
    cognitoUserPoolClientId: $client,
    awsLoadBalancerUrl: $awsLb
  }'

run_cmd gcloud services enable run.googleapis.com artifactregistry.googleapis.com --project "$PROJECT_ID"

if [ "$DRY_RUN" = "true" ]; then
  echo "+ gcloud artifacts repositories describe $REPOSITORY --location $ARTIFACT_REGION --project $PROJECT_ID"
  echo "+ gcloud auth configure-docker $REGISTRY_HOST --quiet"
else
  if ! gcloud artifacts repositories describe "$REPOSITORY" \
    --location "$ARTIFACT_REGION" \
    --project "$PROJECT_ID" >/dev/null 2>&1; then
    run_cmd gcloud artifacts repositories create "$REPOSITORY" \
      --location "$ARTIFACT_REGION" \
      --project "$PROJECT_ID" \
      --repository-format docker \
      --description "NetPulse multi-cloud runtime images"
  fi
  run_cmd gcloud auth configure-docker "$REGISTRY_HOST" --quiet
fi

build_and_push_image services/load-balancer/Dockerfile.demo-backend "$BACKEND_IMAGE"
build_and_push_image services/load-balancer/Dockerfile "$LOAD_BALANCER_IMAGE"

run_cmd gcloud run deploy "$BACKEND_A_SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$BACKEND_IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 5 \
  --cpu 1 \
  --memory 512Mi \
  --env-vars-file "$BACKEND_A_ENV_FILE"

run_cmd gcloud run deploy "$BACKEND_B_SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$BACKEND_IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 5 \
  --cpu 1 \
  --memory 512Mi \
  --env-vars-file "$BACKEND_B_ENV_FILE"

if [ "$DRY_RUN" = "true" ]; then
  BACKEND_A_URL="$(placeholder_url "$BACKEND_A_SERVICE")"
  BACKEND_B_URL="$(placeholder_url "$BACKEND_B_SERVICE")"
else
  BACKEND_A_URL="$(describe_service_url "$BACKEND_A_SERVICE")"
  BACKEND_B_URL="$(describe_service_url "$BACKEND_B_SERVICE")"
fi

BACKEND_A_URL="$(trim_trailing_slash "$BACKEND_A_URL")"
BACKEND_B_URL="$(trim_trailing_slash "$BACKEND_B_URL")"
GCP_STATIC_BACKENDS="${BACKEND_A_SERVICE}=${BACKEND_A_URL}/health,${BACKEND_B_SERVICE}=${BACKEND_B_URL}/health"

write_env_file "$LOAD_BALANCER_ENV_FILE" \
  DISCOVERY_PROVIDER "static" \
  STATIC_BACKENDS "$GCP_STATIC_BACKENDS" \
  HEALTH_CHECK_INTERVAL_MS "5000" \
  DISCOVERY_REFRESH_INTERVAL_MS "10000" \
  REQUEST_TIMEOUT_MS "10000" \
  CIRCUIT_OPEN_AFTER_FAILURES "3" \
  CIRCUIT_HALF_OPEN_MAX_REQUESTS "1" \
  CIRCUIT_RESET_TIMEOUT_MS "15000"

run_cmd gcloud run deploy "$LOAD_BALANCER_SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$LOAD_BALANCER_IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 10 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 200 \
  --env-vars-file "$LOAD_BALANCER_ENV_FILE"

if [ "$DRY_RUN" = "true" ]; then
  GCP_LOAD_BALANCER_URL="$(placeholder_url "$LOAD_BALANCER_SERVICE")"
else
  GCP_LOAD_BALANCER_URL="$(describe_service_url "$LOAD_BALANCER_SERVICE")"
fi
GCP_LOAD_BALANCER_URL="$(trim_trailing_slash "$GCP_LOAD_BALANCER_URL")"

write_env_file "$WEB_ENV_FILE" \
  NEXT_PUBLIC_API_BASE_URL "$API_BASE_URL" \
  NEXT_PUBLIC_WS_URL "$WS_URL" \
  NEXT_PUBLIC_COGNITO_USER_POOL_ID "$COGNITO_USER_POOL_ID" \
  NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID "$COGNITO_USER_POOL_CLIENT_ID" \
  NEXT_PUBLIC_LOAD_BALANCER_URL "$GCP_LOAD_BALANCER_URL" \
  NEXT_PUBLIC_LOAD_BALANCER_HEALTH_PATH "/backends" \
  NEXT_PUBLIC_AWS_LOAD_BALANCER_URL "$AWS_LOAD_BALANCER_URL" \
  NEXT_PUBLIC_GCP_LOAD_BALANCER_URL "$GCP_LOAD_BALANCER_URL" \
  NEXT_PUBLIC_GRAFANA_DASHBOARD_URL "$GRAFANA_DASHBOARD_URL" \
  NEXT_PUBLIC_PROMETHEUS_URL "$PROMETHEUS_URL" \
  NEXT_PUBLIC_DEMO_ORG_ID "$DEMO_ORG_ID" \
  NEXT_PUBLIC_DEFAULT_WORKSPACE_NAME "$DEFAULT_WORKSPACE_NAME" \
  NEXT_PUBLIC_DEFAULT_ENDPOINT_NAME "$DEFAULT_ENDPOINT_NAME" \
  NEXT_PUBLIC_DEFAULT_ENDPOINT_URL "$DEFAULT_ENDPOINT_URL"

build_and_push_image apps/web/Dockerfile "$WEB_IMAGE" \
  --build-arg "NEXT_PUBLIC_API_BASE_URL=$API_BASE_URL" \
  --build-arg "NEXT_PUBLIC_WS_URL=$WS_URL" \
  --build-arg "NEXT_PUBLIC_COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID" \
  --build-arg "NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID=$COGNITO_USER_POOL_CLIENT_ID" \
  --build-arg "NEXT_PUBLIC_LOAD_BALANCER_URL=$GCP_LOAD_BALANCER_URL" \
  --build-arg "NEXT_PUBLIC_LOAD_BALANCER_HEALTH_PATH=/backends" \
  --build-arg "NEXT_PUBLIC_AWS_LOAD_BALANCER_URL=$AWS_LOAD_BALANCER_URL" \
  --build-arg "NEXT_PUBLIC_GCP_LOAD_BALANCER_URL=$GCP_LOAD_BALANCER_URL" \
  --build-arg "NEXT_PUBLIC_GRAFANA_DASHBOARD_URL=$GRAFANA_DASHBOARD_URL" \
  --build-arg "NEXT_PUBLIC_PROMETHEUS_URL=$PROMETHEUS_URL" \
  --build-arg "NEXT_PUBLIC_DEMO_ORG_ID=$DEMO_ORG_ID" \
  --build-arg "NEXT_PUBLIC_DEFAULT_WORKSPACE_NAME=$DEFAULT_WORKSPACE_NAME" \
  --build-arg "NEXT_PUBLIC_DEFAULT_ENDPOINT_NAME=$DEFAULT_ENDPOINT_NAME" \
  --build-arg "NEXT_PUBLIC_DEFAULT_ENDPOINT_URL=$DEFAULT_ENDPOINT_URL"

run_cmd gcloud run deploy "$WEB_SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$WEB_IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 5 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 100 \
  --env-vars-file "$WEB_ENV_FILE"

if [ "$DRY_RUN" = "true" ]; then
  GCP_WEB_URL="$(placeholder_url "$WEB_SERVICE")"
else
  GCP_WEB_URL="$(describe_service_url "$WEB_SERVICE")"
fi
GCP_WEB_URL="$(trim_trailing_slash "$GCP_WEB_URL")"

write_env_file "$WEB_ENV_FILE" \
  NEXT_PUBLIC_API_BASE_URL "$API_BASE_URL" \
  NEXT_PUBLIC_WS_URL "$WS_URL" \
  NEXT_PUBLIC_COGNITO_USER_POOL_ID "$COGNITO_USER_POOL_ID" \
  NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID "$COGNITO_USER_POOL_CLIENT_ID" \
  NEXT_PUBLIC_LOAD_BALANCER_URL "$GCP_LOAD_BALANCER_URL" \
  NEXT_PUBLIC_LOAD_BALANCER_HEALTH_PATH "/backends" \
  NEXT_PUBLIC_AWS_LOAD_BALANCER_URL "$AWS_LOAD_BALANCER_URL" \
  NEXT_PUBLIC_GCP_LOAD_BALANCER_URL "$GCP_LOAD_BALANCER_URL" \
  NEXT_PUBLIC_GCP_WEB_URL "$GCP_WEB_URL" \
  NEXT_PUBLIC_GRAFANA_DASHBOARD_URL "$GRAFANA_DASHBOARD_URL" \
  NEXT_PUBLIC_PROMETHEUS_URL "$PROMETHEUS_URL" \
  NEXT_PUBLIC_DEMO_ORG_ID "$DEMO_ORG_ID" \
  NEXT_PUBLIC_DEFAULT_WORKSPACE_NAME "$DEFAULT_WORKSPACE_NAME" \
  NEXT_PUBLIC_DEFAULT_ENDPOINT_NAME "$DEFAULT_ENDPOINT_NAME" \
  NEXT_PUBLIC_DEFAULT_ENDPOINT_URL "$DEFAULT_ENDPOINT_URL"

run_cmd gcloud run deploy "$WEB_SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$WEB_IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --min-instances 0 \
  --max-instances 5 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 100 \
  --env-vars-file "$WEB_ENV_FILE"

log "Deployment summary"
jq -n \
  --arg env "$ENV_NAME" \
  --arg project "$PROJECT_ID" \
  --arg region "$REGION" \
  --arg backendA "$BACKEND_A_URL" \
  --arg backendB "$BACKEND_B_URL" \
  --arg gcpLb "$GCP_LOAD_BALANCER_URL" \
  --arg gcpWeb "$GCP_WEB_URL" \
  --arg awsApi "$API_BASE_URL" \
  --arg awsWs "$WS_URL" \
  --arg awsLb "$AWS_LOAD_BALANCER_URL" \
  '{
    env: $env,
    project: $project,
    region: $region,
    backends: {
      backendA: $backendA,
      backendB: $backendB
    },
    gcpLoadBalancerUrl: $gcpLb,
    gcpWebUrl: $gcpWeb,
    awsControlPlane: {
      apiBaseUrl: $awsApi,
      wsUrl: $awsWs,
      awsLoadBalancerUrl: $awsLb
    }
  }'
