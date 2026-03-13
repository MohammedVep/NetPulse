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
if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required" >&2
  exit 1
fi

usage() {
  cat <<EOF
Usage:
  $(basename "$0") [--bootstrap-profile netpulse-root] [--region us-east-1] [--account-id 123456789012] [--deployer-user netpulse-deployer]

This script:
1) creates/updates a least-privilege CloudFormation execution policy for CDK bootstrap,
2) updates CDKToolkit bootstrap stack to use that policy,
3) creates a dedicated IAM deploy user with AssumeRole permissions for CDK roles + CloudFormation read access,
4) rewires local netpulse profiles to use role assumption (no direct root keys).
EOF
}

BOOTSTRAP_PROFILE="netpulse-root"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=""
DEPLOYER_USER="netpulse-deployer"

while [ $# -gt 0 ]; do
  case "$1" in
    --bootstrap-profile)
      BOOTSTRAP_PROFILE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --account-id)
      ACCOUNT_ID="$2"
      shift 2
      ;;
    --deployer-user)
      DEPLOYER_USER="$2"
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

if [ -z "$ACCOUNT_ID" ]; then
  ACCOUNT_ID="$(aws sts get-caller-identity \
    --region "$REGION" \
    --profile "$BOOTSTRAP_PROFILE" \
    --query Account \
    --output text)"
fi

if [ -z "$ACCOUNT_ID" ] || [ "$ACCOUNT_ID" = "None" ]; then
  echo "Unable to resolve AWS account id" >&2
  exit 1
fi

CFN_EXEC_POLICY_NAME="NetPulseCfnExecutionPolicy"
ASSUME_POLICY_NAME="NetPulseAssumeCdkRolesPolicy"
CFN_READ_POLICY_NAME="NetPulseCloudFormationReadPolicy"
CFN_EXEC_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${CFN_EXEC_POLICY_NAME}"
ASSUME_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${ASSUME_POLICY_NAME}"
CFN_READ_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${CFN_READ_POLICY_NAME}"

QUALIFIER="hnb659fds"
DEPLOY_ROLE_NAME="cdk-${QUALIFIER}-deploy-role-${ACCOUNT_ID}-${REGION}"
FILE_ROLE_NAME="cdk-${QUALIFIER}-file-publishing-role-${ACCOUNT_ID}-${REGION}"
IMAGE_ROLE_NAME="cdk-${QUALIFIER}-image-publishing-role-${ACCOUNT_ID}-${REGION}"
LOOKUP_ROLE_NAME="cdk-${QUALIFIER}-lookup-role-${ACCOUNT_ID}-${REGION}"

DEPLOY_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOY_ROLE_NAME}"
FILE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${FILE_ROLE_NAME}"
IMAGE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${IMAGE_ROLE_NAME}"
LOOKUP_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${LOOKUP_ROLE_NAME}"

DEPLOY_CHAIN_POLICY_NAME="NetPulseDeployRoleAssumeBootstrapRoles"
DEPLOY_ECS_OPS_POLICY_NAME="NetPulseDeployRoleEcsOperations"

WORKDIR="$(pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CFN_EXEC_POLICY_FILE="$TMP_DIR/cfn-exec-policy.json"
ASSUME_POLICY_FILE="$TMP_DIR/assume-role-policy.json"
CFN_READ_POLICY_FILE="$TMP_DIR/cfn-read-policy.json"
DEPLOY_CHAIN_POLICY_FILE="$TMP_DIR/deploy-role-chain-policy.json"
DEPLOY_ECS_OPS_POLICY_FILE="$TMP_DIR/deploy-role-ecs-ops-policy.json"

cat >"$CFN_EXEC_POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NetPulseProvisioning",
      "Effect": "Allow",
      "Action": [
        "apigateway:*",
        "cloudwatch:*",
        "cognito-idp:*",
        "dynamodb:*",
        "events:*",
        "iam:AttachRolePolicy",
        "iam:CreateRole",
        "iam:CreateServiceLinkedRole",
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:PassRole",
        "iam:PutRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "lambda:*",
        "logs:*",
        "s3:*",
        "sns:*",
        "ssm:GetParameters",
        "sqs:*"
      ],
      "Resource": "*"
    }
  ]
}
JSON

cat >"$ASSUME_POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ],
      "Resource": [
        "${DEPLOY_ROLE_ARN}",
        "${FILE_ROLE_ARN}",
        "${IMAGE_ROLE_ARN}",
        "${LOOKUP_ROLE_ARN}"
      ]
    }
  ]
}
JSON

cat >"$CFN_READ_POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationReadOnly",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources",
        "cloudformation:DescribeStacks",
        "cloudformation:GetTemplate",
        "cloudformation:ListStackResources",
        "cloudformation:ListStacks"
      ],
      "Resource": "*"
    }
  ]
}
JSON

cat >"$DEPLOY_CHAIN_POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeBootstrapPublishingRoles",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ],
      "Resource": [
        "${FILE_ROLE_ARN}",
        "${IMAGE_ROLE_ARN}",
        "${LOOKUP_ROLE_ARN}"
      ]
    }
  ]
}
JSON

cat >"$DEPLOY_ECS_OPS_POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NetPulseEcsInventory",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeClusters",
        "ecs:DescribeServices",
        "ecs:DescribeTasks",
        "ecs:ListClusters",
        "ecs:ListServices",
        "ecs:ListTasks"
      ],
      "Resource": "*"
    },
    {
      "Sid": "NetPulseEcsServiceUpdates",
      "Effect": "Allow",
      "Action": [
        "ecs:UpdateService"
      ],
      "Resource": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/np-lb-cluster-*/*"
    }
  ]
}
JSON

upsert_managed_policy() {
  local policy_name="$1"
  local policy_arn="$2"
  local policy_file="$3"

  if aws iam get-policy --profile "$BOOTSTRAP_PROFILE" --region "$REGION" --policy-arn "$policy_arn" >/dev/null 2>&1; then
    local non_default_versions
    non_default_versions="$(aws iam list-policy-versions \
      --profile "$BOOTSTRAP_PROFILE" \
      --region "$REGION" \
      --policy-arn "$policy_arn" \
      --query "Versions[?IsDefaultVersion==\`false\`].VersionId" \
      --output text)"

    local version_count
    version_count="$(aws iam list-policy-versions \
      --profile "$BOOTSTRAP_PROFILE" \
      --region "$REGION" \
      --policy-arn "$policy_arn" \
      --query "length(Versions)" \
      --output text)"

    if [ "${version_count:-0}" -ge 5 ] && [ -n "$non_default_versions" ]; then
      local oldest
      oldest="$(aws iam list-policy-versions \
        --profile "$BOOTSTRAP_PROFILE" \
        --region "$REGION" \
        --policy-arn "$policy_arn" \
        --query "Versions[?IsDefaultVersion==\`false\`]|sort_by(@,&CreateDate)[0].VersionId" \
        --output text)"
      if [ -n "$oldest" ] && [ "$oldest" != "None" ]; then
        aws iam delete-policy-version \
          --profile "$BOOTSTRAP_PROFILE" \
          --region "$REGION" \
          --policy-arn "$policy_arn" \
          --version-id "$oldest" >/dev/null
      fi
    fi

    aws iam create-policy-version \
      --profile "$BOOTSTRAP_PROFILE" \
      --region "$REGION" \
      --policy-arn "$policy_arn" \
      --policy-document "file://$policy_file" \
      --set-as-default >/dev/null
  else
    aws iam create-policy \
      --profile "$BOOTSTRAP_PROFILE" \
      --region "$REGION" \
      --policy-name "$policy_name" \
      --policy-document "file://$policy_file" >/dev/null
  fi
}

echo "Updating managed policy: $CFN_EXEC_POLICY_NAME"
upsert_managed_policy "$CFN_EXEC_POLICY_NAME" "$CFN_EXEC_POLICY_ARN" "$CFN_EXEC_POLICY_FILE"

echo "Re-bootstrapping CDKToolkit with least-privilege execution policy"
(
  cd "$WORKDIR/infra/cdk"
  npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}" \
    --profile "$BOOTSTRAP_PROFILE" \
    --cloudformation-execution-policies "$CFN_EXEC_POLICY_ARN" \
    --output "$TMP_DIR/cdk.out.bootstrap"
)

echo "Ensuring deploy role can chain-assume file/image/lookup bootstrap roles"
aws iam put-role-policy \
  --profile "$BOOTSTRAP_PROFILE" \
  --region "$REGION" \
  --role-name "$DEPLOY_ROLE_NAME" \
  --policy-name "$DEPLOY_CHAIN_POLICY_NAME" \
  --policy-document "file://$DEPLOY_CHAIN_POLICY_FILE" >/dev/null

echo "Ensuring deploy role can inspect and rotate NetPulse ECS services"
aws iam put-role-policy \
  --profile "$BOOTSTRAP_PROFILE" \
  --region "$REGION" \
  --role-name "$DEPLOY_ROLE_NAME" \
  --policy-name "$DEPLOY_ECS_OPS_POLICY_NAME" \
  --policy-document "file://$DEPLOY_ECS_OPS_POLICY_FILE" >/dev/null

echo "Ensuring IAM deployer user: $DEPLOYER_USER"
if ! aws iam get-user --profile "$BOOTSTRAP_PROFILE" --region "$REGION" --user-name "$DEPLOYER_USER" >/dev/null 2>&1; then
  aws iam create-user \
    --profile "$BOOTSTRAP_PROFILE" \
    --region "$REGION" \
    --user-name "$DEPLOYER_USER" >/dev/null
fi

echo "Updating managed policy: $ASSUME_POLICY_NAME"
upsert_managed_policy "$ASSUME_POLICY_NAME" "$ASSUME_POLICY_ARN" "$ASSUME_POLICY_FILE"

echo "Updating managed policy: $CFN_READ_POLICY_NAME"
upsert_managed_policy "$CFN_READ_POLICY_NAME" "$CFN_READ_POLICY_ARN" "$CFN_READ_POLICY_FILE"

aws iam attach-user-policy \
  --profile "$BOOTSTRAP_PROFILE" \
  --region "$REGION" \
  --user-name "$DEPLOYER_USER" \
  --policy-arn "$ASSUME_POLICY_ARN" >/dev/null

aws iam attach-user-policy \
  --profile "$BOOTSTRAP_PROFILE" \
  --region "$REGION" \
  --user-name "$DEPLOYER_USER" \
  --policy-arn "$CFN_READ_POLICY_ARN" >/dev/null

ACTIVE_KEY_COUNT="$(aws iam list-access-keys \
  --profile "$BOOTSTRAP_PROFILE" \
  --region "$REGION" \
  --user-name "$DEPLOYER_USER" \
  --query "length(AccessKeyMetadata[?Status=='Active'])" \
  --output text)"

NEW_ACCESS_KEY_ID=""
NEW_SECRET_ACCESS_KEY=""

if [ "${ACTIVE_KEY_COUNT:-0}" -eq 0 ]; then
  KEY_JSON="$(aws iam create-access-key \
    --profile "$BOOTSTRAP_PROFILE" \
    --region "$REGION" \
    --user-name "$DEPLOYER_USER")"
  NEW_ACCESS_KEY_ID="$(echo "$KEY_JSON" | jq -r ".AccessKey.AccessKeyId")"
  NEW_SECRET_ACCESS_KEY="$(echo "$KEY_JSON" | jq -r ".AccessKey.SecretAccessKey")"
else
  echo "Deployer user already has an active access key. Keeping existing key(s)."
fi

if [ -n "$NEW_ACCESS_KEY_ID" ] && [ -n "$NEW_SECRET_ACCESS_KEY" ]; then
  echo "Writing local source profile: netpulse-base"
  aws configure set aws_access_key_id "$NEW_ACCESS_KEY_ID" --profile netpulse-base
  aws configure set aws_secret_access_key "$NEW_SECRET_ACCESS_KEY" --profile netpulse-base
  aws configure set region "$REGION" --profile netpulse-base
  aws configure set output json --profile netpulse-base
fi

for env in dev staging prod; do
  profile="netpulse-${env}"
  aws configure set region "$REGION" --profile "$profile"
  aws configure set output json --profile "$profile"
  aws configure set role_arn "$DEPLOY_ROLE_ARN" --profile "$profile"
  aws configure set source_profile netpulse-base --profile "$profile"
  aws configure set role_session_name "$profile" --profile "$profile"

  static_key="$(aws configure get aws_access_key_id --profile "$profile" || true)"
  if [ -n "$static_key" ]; then
    echo "WARNING: $profile still has static credentials in ~/.aws/credentials."
    echo "         Remove aws_access_key_id/aws_secret_access_key entries for $profile to enforce role-only auth."
  fi
done

echo "Validating role-based profiles"
for env in dev staging prod; do
  profile="netpulse-${env}"
  ARN=""
  for attempt in 1 2 3 4 5; do
    if ARN="$(aws sts get-caller-identity --profile "$profile" --region "$REGION" --query Arn --output text 2>/dev/null)"; then
      break
    fi
    sleep 2
  done
  if [ -z "$ARN" ]; then
    echo "Failed to validate profile after retries: $profile" >&2
    exit 1
  fi
  echo "  $profile -> $ARN"
done

echo
echo "IAM deploy setup complete."
echo "CDK deploy role: $DEPLOY_ROLE_ARN"
echo "CloudFormation execution policy: $CFN_EXEC_POLICY_ARN"
echo "If old root access keys remain in ~/.aws/credentials, rotate/delete them from the root account."
