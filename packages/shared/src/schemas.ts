import { z } from "zod";

export const roleSchema = z.enum(["Owner", "Admin", "Editor", "Viewer"]);
export const endpointProtocolSchema = z.enum(["HTTP", "HTTPS"]);
export const endpointStatusSchema = z.enum(["HEALTHY", "DEGRADED", "DOWN", "PAUSED", "DELETED"]);
export const incidentStateSchema = z.enum(["OPEN", "RESOLVED"]);
export const metricsWindowSchema = z.enum(["24h", "7d", "30d"]);
export const monitoringRegionSchema = z.enum([
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "ap-southeast-1"
]);
export const channelTypeSchema = z.enum(["EMAIL", "SLACK", "WEBHOOK"]);
export const alertEventSchema = z.enum([
  "INCIDENT_OPEN",
  "INCIDENT_RESOLVED",
  "SLO_BURN_RATE",
  "LATENCY_BREACH",
  "FAILURE_RATE_BREACH"
]);
export const failureSimulationModeSchema = z.enum(["FORCE_FAIL", "FORCE_DEGRADED"]);

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }

  const octets = match.slice(1).map((value) => Number(value));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }

  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

const httpsPublicUrlSchema = z.string().url().superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid URL"
    });
    return;
  }

  if (parsed.protocol !== "https:") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "URL must use HTTPS"
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Localhost URLs are not allowed"
    });
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Private IP addresses are not allowed"
    });
  }
});

export const createOrganizationSchema = z.object({
  name: z.string().min(3).max(80)
});

export const upsertMemberSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  role: roleSchema,
  isActive: z.boolean().optional()
});

export const createEndpointSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(3).max(120),
  url: z.string().url(),
  timeoutMs: z.number().int().min(1000).max(10000).default(6000),
  tags: z.array(z.string().min(1).max(30)).max(12).default([]),
  checkRegions: z
    .array(monitoringRegionSchema)
    .min(1)
    .max(4)
    .default(["us-east-1"])
    .refine((regions) => new Set(regions).size === regions.length, "Regions must be unique"),
  slaTargetPct: z.number().min(90).max(100).default(99.9),
  latencyThresholdMs: z.number().int().min(100).max(120000).default(2000),
  failureRateThresholdPct: z.number().min(1).max(100).default(5)
});

export const updateEndpointSchema = z.object({
  name: z.string().min(3).max(120).optional(),
  url: z.string().url().optional(),
  timeoutMs: z.number().int().min(1000).max(10000).optional(),
  tags: z.array(z.string().min(1).max(30)).max(12).optional(),
  paused: z.boolean().optional(),
  checkRegions: z
    .array(monitoringRegionSchema)
    .min(1)
    .max(4)
    .refine((regions) => new Set(regions).size === regions.length, "Regions must be unique")
    .optional(),
  slaTargetPct: z.number().min(90).max(100).optional(),
  latencyThresholdMs: z.number().int().min(100).max(120000).optional(),
  failureRateThresholdPct: z.number().min(1).max(100).optional()
});

export const checksQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  cursor: z.string().optional()
});

export const metricsQuerySchema = z.object({
  window: metricsWindowSchema
});

export const incidentListQuerySchema = z.object({
  orgId: z.string().min(1),
  status: z.enum(["open", "resolved"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const listEndpointsQuerySchema = z.object({
  orgId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export const emailChannelSchema = z.object({
  orgId: z.string().min(1),
  email: z.string().email()
});

export const slackChannelSchema = z.object({
  orgId: z.string().min(1),
  webhookUrl: httpsPublicUrlSchema
});

export const webhookChannelSchema = z
  .object({
    orgId: z.string().min(1),
    name: z.string().min(1).max(80),
    url: httpsPublicUrlSchema,
    events: z
      .array(alertEventSchema)
      .min(1)
      .max(5)
      .default(["INCIDENT_OPEN", "INCIDENT_RESOLVED"])
      .refine((events) => new Set(events).size === events.length, "Events must be unique"),
    secretHeaderName: z.string().min(1).max(128).optional(),
    secretHeaderValue: z.string().min(1).max(512).optional()
  })
  .superRefine((value, context) => {
    if (Boolean(value.secretHeaderName) !== Boolean(value.secretHeaderValue)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "secretHeaderName and secretHeaderValue must be provided together",
        path: ["secretHeaderName"]
      });
    }
  });

export const dashboardSummaryQuerySchema = z.object({
  orgId: z.string().min(1),
  window: metricsWindowSchema
});

export const aiInsightsQuerySchema = z.object({
  orgId: z.string().min(1),
  window: metricsWindowSchema
});

export const endpointSlaQuerySchema = z.object({
  window: metricsWindowSchema
});

export const incidentTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(5).max(500).optional()
});

export const failureSimulationSchema = z
  .object({
    mode: z.enum(["FORCE_FAIL", "FORCE_DEGRADED", "CLEAR"]),
    failureStatusCode: z.number().int().min(100).max(599).optional(),
    forcedLatencyMs: z.number().int().min(1).max(60000).optional(),
    durationMinutes: z.number().int().min(1).max(24 * 60).optional()
  })
  .superRefine((value, context) => {
    if (value.mode === "CLEAR") {
      if (value.failureStatusCode !== undefined || value.forcedLatencyMs !== undefined || value.durationMinutes !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "CLEAR simulation does not accept extra fields",
          path: ["mode"]
        });
      }
      return;
    }

    if (value.mode === "FORCE_DEGRADED" && value.failureStatusCode !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failureStatusCode is not supported for FORCE_DEGRADED",
        path: ["failureStatusCode"]
      });
    }

    if (value.mode === "FORCE_FAIL" && value.forcedLatencyMs !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "forcedLatencyMs is not supported for FORCE_FAIL",
        path: ["forcedLatencyMs"]
      });
    }
  });

export const websocketSubscriptionSchema = z.object({
  orgId: z.string().min(1),
  endpointIds: z.array(z.string().min(1)).max(250).optional(),
  token: z.string().min(1).optional()
});
