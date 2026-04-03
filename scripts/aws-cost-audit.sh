#!/usr/bin/env bash
set -euo pipefail

PROFILE="netpulse-root"
REGION="us-east-1"
START_DATE="2026-03-01"
END_DATE="2026-04-01"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--profile <aws-profile>] [--region <aws-region>] [--start <YYYY-MM-DD>] [--end <YYYY-MM-DD>]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --start)
      START_DATE="$2"
      shift 2
      ;;
    --end)
      END_DATE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

aws_cmd=(/opt/homebrew/bin/aws --profile "$PROFILE" --region "$REGION")

echo "=== Cost by service ($START_DATE to $END_DATE) ==="
"${aws_cmd[@]}" ce get-cost-and-usage \
  --time-period Start="$START_DATE",End="$END_DATE" \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --output json \
  | jq -r '.ResultsByTime[0].Groups[] | [.Keys[0], .Metrics.UnblendedCost.Amount] | @tsv' \
  | sort -k2,2nr

echo
echo "=== App Runner inventory (all regions) ==="
for region_name in $("${aws_cmd[@]}" ec2 describe-regions --query 'Regions[].RegionName' --output text); do
  count=$(/opt/homebrew/bin/aws --profile "$PROFILE" --region "$region_name" apprunner list-services --query 'length(ServiceSummaryList)' --output text 2>/dev/null || echo ERR)
  if [[ "$count" != "0" && "$count" != "ERR" ]]; then
    echo "-- $region_name ($count service(s))"
    /opt/homebrew/bin/aws --profile "$PROFILE" --region "$region_name" apprunner list-services \
      --query 'ServiceSummaryList[].{name:ServiceName,status:Status,url:ServiceUrl}' --output table
  fi
done

echo
echo "=== VPC endpoints ($REGION) ==="
"${aws_cmd[@]}" ec2 describe-vpc-endpoints \
  --query 'VpcEndpoints[].{VpcId:VpcId,Id:VpcEndpointId,Service:ServiceName,Type:VpcEndpointType,State:State}' \
  --output table

echo
echo "=== NetPulse secrets ($REGION) ==="
"${aws_cmd[@]}" secretsmanager list-secrets \
  --output json \
  | jq '[.SecretList[] | select(.Name | startswith("netpulse/"))] | {count:length, names: map(.Name)}'
