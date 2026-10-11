# EAS on RumptyCloud

RumptyCloud fits EAS's persistence needs: use managed PostgreSQL for sessions, saved courses, lesson attempts, and sharing metadata; use a **private** S3-compatible bucket for uploaded PDFs and extracted assets. Course share links are application URLs backed by a random, revocable token in PostgreSQL. They never point at the source-file bucket.

## Required application settings

Create a RumptyCloud Postgres database and a private bucket in the same workspace. After each resource is `Ready`, put the following secrets in the EAS deployment's environment settings:

```dotenv
ENVIRONMENT=production
DATABASE_URL=postgresql+asyncpg://USER:PASSWORD@HOST:5432/DATABASE
STORAGE_BACKEND=s3
S3_BUCKET=YOUR_PRIVATE_BUCKET_NAME
S3_ENDPOINT_URL=THE_S3_ENDPOINT_SHOWN_BY_RUMPTY
AWS_ACCESS_KEY_ID=THE_BUCKET_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=THE_BUCKET_SECRET_KEY
AWS_REGION=THE_REGION_SHOWN_BY_RUMPTY
```

Use the bucket's S3 SDK credentials and endpoint, not the browser/CDN base URL. Keep this bucket private. Do not commit the connection string or bucket credentials. Boto3 reads the standard AWS credential variables above. The API and worker need the same database and bucket settings so workers can read uploads and write derived assets.

Run `alembic upgrade head` as the deployment's pre-start/release command before starting the API. Run one worker service alongside the API, using the same image and environment but command `python -m services.worker.eas_worker.runner`. The API serves the static Next.js export from that same image. Configure the Rumpty deployment port to match the container `PORT` (the image defaults to 8000) and use `/v1/health` for an unauthenticated health check.

## Data durability and backups

The course dashboard, visibility, exact resume pointer, and completed-lesson state live in PostgreSQL, so they survive browser storage cleanup and app rebuilds while the same `eas_session` cookie is present. EAS currently identifies an owner by that browser cookie rather than an account login, so restoring a cookie on another device is not provided. Uploaded sources stay private in the bucket. The share page only returns lesson text and page-level excerpts selected for the course; it does not grant access to the PDF object.

RumptyCloud's current database backup guide says managed scheduled backups, point-in-time recovery, and managed restore are not available. Schedule `python -m infrastructure.scripts.backup_postgres` from a separate environment that has `pg_dump`, `DATABASE_URL`, the private bucket's S3 credentials, and the bucket endpoint. Set `BACKUP_BUCKET` to a private backup bucket (or `S3_BUCKET` if deliberately sharing the storage bucket). Keep a retention policy and periodically restore a dump into a separate database before relying on it. The backup script uploads a compressed custom-format PostgreSQL dump; it does not configure a schedule or retention by itself.

## Cloud-resource status

The EAS workspace (`eas-01a10e24`) has a free PostgreSQL database named `eas-postgres` and a private bucket named `eas-sources`. The database and bucket were provisioned in RumptyCloud; their credentials are intentionally not stored in this repository. The database was recreated after its initial generated password appeared in a tool result. Although the public-endpoint option was off in the create form, Rumpty's detail page reports `PUBLIC ENDPOINT Enabled`. Do not treat the database as private-network-only: use the internal host for the deployed app and attach a restrictive firewall policy before production traffic.

The Rumpty CLI build installed for this workspace can list workspaces and manage VMs, copy/execute files, expose VM services, and sync to buckets. It does not include database-management or app-deployment commands. The EAS source directory currently has no Git remote, and no Rumpty app deployment has been created. A GitHub source repository is needed before deployment; add the database and bucket secrets to that deployment's environment only after the repository is connected. Do not put secrets in source control or this chat.
