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
export const failureSimulationModeSchema = z.enum(["NONE", "FORCE_FAIL", "FLAKY", "LATENCY_SPIKE"]);

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
  slaTargetPct: z.number().min(90).max(100).default(99.9)
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
  slaTargetPct: z.number().min(90).max(100).optional()
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
  webhookUrl: z.string().url()
});

export const webhookChannelSchema = z.object({
  orgId: z.string().min(1),
  webhookUrl: z.string().url()
});

export const dashboardSummaryQuerySchema = z.object({
  orgId: z.string().min(1),
  window: metricsWindowSchema
});

export const endpointSlaQuerySchema = z.object({
  window: metricsWindowSchema
});

export const failureSimulationSchema = z
  .object({
    mode: z.enum(["FORCE_FAIL", "FLAKY", "LATENCY_SPIKE"]),
    until: z.string().datetime().optional(),
    failureRatePct: z.number().int().min(1).max(100).optional(),
    extraLatencyMs: z.number().int().min(1).max(60000).optional()
  })
  .superRefine((value, context) => {
    if (value.mode === "FLAKY" && typeof value.failureRatePct !== "number") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failureRatePct is required for FLAKY simulation",
        path: ["failureRatePct"]
      });
    }

    if (value.mode === "LATENCY_SPIKE" && typeof value.extraLatencyMs !== "number") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "extraLatencyMs is required for LATENCY_SPIKE simulation",
        path: ["extraLatencyMs"]
      });
    }
  });

export const websocketSubscriptionSchema = z.object({
  orgId: z.string().min(1),
  endpointIds: z.array(z.string().min(1)).max(250).optional(),
  token: z.string().min(1).optional()
});
