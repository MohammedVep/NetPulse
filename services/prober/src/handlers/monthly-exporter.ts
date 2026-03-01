import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { ScheduledEvent } from "aws-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { Organization } from "@netpulse/shared";
import { csvLine } from "../lib/csv.js";
import { ddb } from "../lib/db.js";
import { env } from "../lib/env.js";

const s3 = new S3Client({});

function previousMonthBounds(reference = new Date()) {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth();

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    year: start.getUTCFullYear(),
    month: String(start.getUTCMonth() + 1).padStart(2, "0")
  };
}

async function listOrganizations(): Promise<Organization[]> {
  const rows: Organization[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: env.organizationsTable,
        ExclusiveStartKey: lastKey,
        Limit: 100
      })
    );
    rows.push(...((page.Items ?? []) as Organization[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return rows.filter((org) => org.isActive);
}

async function listOrgProbeRows(orgId: string, startIso: string, endIso: string) {
  const rows: Array<Record<string, unknown>> = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: env.probeResultsTable,
        FilterExpression: "begins_with(probePk, :probePk) AND timestampIso BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":probePk": `${orgId}#`,
          ":from": startIso,
          ":to": endIso
        },
        ExclusiveStartKey: lastKey
      })
    );

    rows.push(...(page.Items ?? []));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return rows;
}

async function uploadOrgReport(orgId: string, rows: Array<Record<string, unknown>>, year: number, month: string) {
  const header = csvLine([
    "timestampIso",
    "endpointId",
    "region",
    "ok",
    "statusCode",
    "latencyMs",
    "errorType",
    "simulated"
  ]);

  const body =
    header +
    rows
      .map((row) =>
        csvLine([
          row.timestampIso as string,
          row.endpointId as string,
          (row.region as string | undefined) ?? "",
          String(Boolean(row.ok)),
          (row.statusCode as number | undefined) ?? "",
          (row.latencyMs as number | undefined) ?? "",
          (row.errorType as string | undefined) ?? "",
          String(Boolean(row.simulated))
        ])
      )
      .join("");

  const gzipped = gzipSync(Buffer.from(body, "utf8"));
  const checksum = createHash("sha256").update(gzipped).digest("hex");

  const keyPrefix = `orgId=${orgId}/year=${year}/month=${month}`;

  await Promise.all([
    s3.send(
      new PutObjectCommand({
        Bucket: env.monthlyReportsBucket,
        Key: `${keyPrefix}/netpulse-health.csv.gz`,
        Body: gzipped,
        ContentType: "application/gzip"
      })
    ),
    s3.send(
      new PutObjectCommand({
        Bucket: env.monthlyReportsBucket,
        Key: `${keyPrefix}/manifest.json`,
        Body: JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            rowCount: rows.length,
            checksum,
            file: "netpulse-health.csv.gz"
          },
          null,
          2
        ),
        ContentType: "application/json"
      })
    )
  ]);
}

export async function handler(_event: ScheduledEvent) {
  const { startIso, endIso, year, month } = previousMonthBounds();
  const organizations = await listOrganizations();

  const summary: Array<{ orgId: string; rows: number }> = [];

  for (const org of organizations) {
    const rows = await listOrgProbeRows(org.orgId, startIso, endIso);
    await uploadOrgReport(org.orgId, rows, year, month);
    summary.push({ orgId: org.orgId, rows: rows.length });
  }

  return {
    month,
    year,
    generated: summary.length,
    summary
  };
}
