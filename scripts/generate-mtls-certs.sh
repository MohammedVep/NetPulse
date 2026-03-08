#!/usr/bin/env bash

set -euo pipefail

CERT_DIR="${MTLS_CERT_DIR:-infra/high-concurrency/mtls/certs}"
FORCE="${1:-}"

if [[ -f "$CERT_DIR/ca.crt" && "$FORCE" != "--force" ]]; then
  echo "Certificates already exist in $CERT_DIR (use --force to regenerate)."
  exit 0
fi

mkdir -p "$CERT_DIR"

rm -f "$CERT_DIR"/*.crt "$CERT_DIR"/*.csr "$CERT_DIR"/*.key "$CERT_DIR"/*.srl

openssl genrsa -out "$CERT_DIR/ca.key" 4096
openssl req -x509 -new -nodes -key "$CERT_DIR/ca.key" -sha256 -days 3650 \
  -subj "/C=US/ST=CA/L=Toronto/O=NetPulse/CN=netpulse-local-ca" \
  -out "$CERT_DIR/ca.crt"

openssl genrsa -out "$CERT_DIR/server.key" 2048
openssl req -new -key "$CERT_DIR/server.key" \
  -subj "/C=US/ST=CA/L=Toronto/O=NetPulse/CN=netpulse-central-queue" \
  -out "$CERT_DIR/server.csr"
cat > "$CERT_DIR/server.ext" <<EXT
subjectAltName = DNS:localhost,IP:127.0.0.1
extendedKeyUsage = serverAuth
EXT
openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial -out "$CERT_DIR/server.crt" -days 825 -sha256 -extfile "$CERT_DIR/server.ext"

openssl genrsa -out "$CERT_DIR/worker.key" 2048
openssl req -new -key "$CERT_DIR/worker.key" \
  -subj "/C=US/ST=CA/L=Toronto/O=NetPulse/CN=regional-worker" \
  -out "$CERT_DIR/worker.csr"
cat > "$CERT_DIR/worker.ext" <<EXT
extendedKeyUsage = clientAuth
EXT
openssl x509 -req -in "$CERT_DIR/worker.csr" -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial -out "$CERT_DIR/worker.crt" -days 825 -sha256 -extfile "$CERT_DIR/worker.ext"

rm -f "$CERT_DIR"/*.csr "$CERT_DIR"/*.ext "$CERT_DIR"/*.srl
chmod 600 "$CERT_DIR"/*.key
chmod 644 "$CERT_DIR"/*.crt

echo "mTLS certificates generated in $CERT_DIR"
