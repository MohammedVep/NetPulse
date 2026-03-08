# High-Concurrency + mTLS Drill Assets

This folder contains local/staging drill infrastructure for two reliability guarantees:

1. PgBouncer in front of PostgreSQL for write burst protection.
2. Mutual TLS (mTLS) between regional workers and central queue transport.

## Files

- `docker-compose.yml`: PostgreSQL + PgBouncer stack.
- `postgres/init/001-schema.sql`: schema used by write-spike drills.
- `pgbouncer/pgbouncer.ini`: template pooling settings (`transaction` mode, high client cap).
- `pgbouncer/userlist.txt`: template local auth users for file-based PgBouncer config.
- `mtls/certs/`: generated CA/server/worker certificates (ignored by git except docs).

## Quickstart

1. `docker compose -f infra/high-concurrency/docker-compose.yml up -d`
2. `TOTAL_WRITES=10000 WRITE_CONCURRENCY=1000 npm run drill:pgbouncer`
3. `npm run certs:mtls`
4. `npm run drill:mtls`
