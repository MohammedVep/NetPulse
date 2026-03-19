# NetPulse on Google Cloud

This directory documents the phase-1 multi-cloud deployment path for NetPulse.

## Scope

NetPulse is not yet cloud-agnostic at the control-plane layer. Today:

- AWS remains the source of truth for Cognito auth, API Gateway, WebSocket fanout, Lambda workers, and DynamoDB persistence.
- Google Cloud Run hosts the portable runtime edge:
  - demo backend A
  - demo backend B
  - the NetPulse load balancer
  - an optional Next.js web frontend

That means the application runs across both AWS and Google Cloud, but the core API/data plane is still anchored on AWS.

## Deployment topology

```text
Google Cloud Run web -> AWS API Gateway + Cognito + WebSocket
Google Cloud Run load balancer -> Google Cloud Run demo backends
AWS load balancer -> AWS ECS demo backends
```

The frontend exposes both runtime surfaces through:

- `NEXT_PUBLIC_AWS_LOAD_BALANCER_URL`
- `NEXT_PUBLIC_GCP_LOAD_BALANCER_URL`
- `NEXT_PUBLIC_GCP_WEB_URL`

## Prerequisites

- `aws` CLI configured for the target NetPulse stack (`netpulse-dev`, `netpulse-staging`, or `netpulse-prod`)
- `docker`
- `jq`
- `gcloud` authenticated to the target project
- Cloud Run API enabled
- Artifact Registry API enabled

Useful IAM roles for the deploying principal:

- `roles/run.admin`
- `roles/artifactregistry.admin`
- `roles/iam.serviceAccountUser`
- permission to push images into the chosen Artifact Registry repository

## Terraform bootstrap

Terraform now manages the repeatable GCP bootstrap layer, and its state now lives in a shared remote AWS backend rather than local workspaces:

- project creation
- billing attachment
- required API enablement (`cloudresourcemanager.googleapis.com`, `serviceusage.googleapis.com`, `run.googleapis.com`, `artifactregistry.googleapis.com`)
- Artifact Registry repository
- remote Terraform state in S3 with DynamoDB locking

Bootstrap the shared Terraform backend:

```bash
npm run tfstate:bootstrap -- \
  --profile netpulse-root \
  --region us-east-1
```

Bootstrap only:

```bash
npm run gcp:bootstrap -- \
  --env dev \
  --project netpulse-multicloud-dev \
  --project-name "NetPulse Multicloud Dev" \
  --billing-account <billing-account-id> \
  --region us-central1
```

The Terraform state is tracked per environment with remote backend keys:

- `infra/gcp/dev.tfstate`
- `infra/gcp/staging.tfstate`
- `infra/gcp/prod.tfstate`

## Deploy

Example for `dev`:

```bash
npm run deploy:gcp:multicloud -- \
  --env dev \
  --project <gcp-project-id> \
  --region us-central1
```

Dry-run only:

```bash
npm run deploy:gcp:multicloud -- \
  --env dev \
  --project <gcp-project-id> \
  --region us-central1 \
  --dry-run
```

## What the deploy script does

1. Resolves the AWS control-plane outputs from `NetPulse-{env}` unless you override them explicitly.
2. Applies the Terraform bootstrap unless `--skip-bootstrap` is set.
3. Builds and pushes three images to Artifact Registry:
   - `demo-backend`
   - `load-balancer`
   - `web`
4. Deploys two Cloud Run demo backends.
5. Deploys the Cloud Run load balancer with `DISCOVERY_PROVIDER=static` and HTTPS backend targets.
6. Deploys the Cloud Run web frontend pointed at the AWS API/WebSocket/Cognito outputs while surfacing both AWS and GCP runtime URLs.

## Operator notes

- The load balancer now accepts `https://...` backend entries in `STATIC_BACKENDS`, which is required for Cloud Run targets.
- The GCP web tier is optional. If Amplify remains the primary frontend, use `scripts/configure-amplify-branch-env.sh` and pass the GCP URLs into Amplify branch variables instead.
- Because the control plane is AWS-native, a full cloud-neutral migration would require abstracting auth, queues, and persistence out of AWS-specific services.
