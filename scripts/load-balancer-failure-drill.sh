#!/usr/bin/env bash
set -euo pipefail

LB_URL="${LB_URL:-http://127.0.0.1:8080}"
BACKEND_ADMIN_URL="${BACKEND_ADMIN_URL:-http://127.0.0.1:3001}"
METRIC_BACKEND_ID="${METRIC_BACKEND_ID:-127.0.0.1:3001}"
TRAFFIC_REQUESTS="${TRAFFIC_REQUESTS:-24}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-2}"
OPEN_TIMEOUT_SECONDS="${OPEN_TIMEOUT_SECONDS:-60}"
RECOVERY_TIMEOUT_SECONDS="${RECOVERY_TIMEOUT_SECONDS:-90}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require curl

set_failure_mode() {
  local unhealthy="$1"
  curl -fsS "${BACKEND_ADMIN_URL}/admin/failure-mode?unhealthy=${unhealthy}" >/dev/null
}

drive_traffic() {
  local count="$1"
  for _ in $(seq 1 "$count"); do
    curl -sS -o /dev/null "${LB_URL}/" || true
  done
}

metrics_snapshot() {
  curl -fsS "${LB_URL}/metrics"
}

wait_for_metric_line() {
  local expected_line="$1"
  local timeout_seconds="$2"
  local start
  start=$(date +%s)

  while true; do
    if metrics_snapshot | grep -F "$expected_line" >/dev/null 2>&1; then
      return 0
    fi

    local now elapsed
    now=$(date +%s)
    elapsed=$((now - start))
    if [[ "$elapsed" -ge "$timeout_seconds" ]]; then
      return 1
    fi

    sleep "$POLL_INTERVAL_SECONDS"
  done
}

echo "Step 1: forcing backend unhealthy (${BACKEND_ADMIN_URL})"
set_failure_mode true

echo "Step 2: driving traffic through ${LB_URL} to trip circuit"
drive_traffic "$TRAFFIC_REQUESTS"

OPEN_LINE="netpulse_lb_backend_circuit_state{backend=\"${METRIC_BACKEND_ID}\",state=\"OPEN\"} 1"
if wait_for_metric_line "$OPEN_LINE" "$OPEN_TIMEOUT_SECONDS"; then
  echo "Circuit opened for ${METRIC_BACKEND_ID}"
else
  echo "Timed out waiting for OPEN circuit metric: ${OPEN_LINE}" >&2
  exit 1
fi

echo "Step 3: restoring backend health"
set_failure_mode false

CLOSED_LINE="netpulse_lb_backend_circuit_state{backend=\"${METRIC_BACKEND_ID}\",state=\"CLOSED\"} 1"
if wait_for_metric_line "$CLOSED_LINE" "$RECOVERY_TIMEOUT_SECONDS"; then
  echo "Circuit recovered to CLOSED for ${METRIC_BACKEND_ID}"
else
  echo "Timed out waiting for CLOSED circuit metric: ${CLOSED_LINE}" >&2
  exit 1
fi

echo "Drill complete. Suggested Grafana panels to inspect:"
echo "- netpulse_lb_backend_circuit_state{backend=\"${METRIC_BACKEND_ID}\"}"
echo "- netpulse_lb_upstream_5xx_total"
echo "- histogram_quantile(0.95, sum(rate(netpulse_lb_request_duration_seconds_bucket[5m])) by (le))"
