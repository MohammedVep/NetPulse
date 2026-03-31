export type Role = "Owner" | "Admin" | "Editor" | "Viewer";

export type EndpointProtocol = "HTTP" | "HTTPS";

export type EndpointStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "PAUSED" | "DELETED";

export type IncidentState = "OPEN" | "RESOLVED";

export type MetricsWindow = "24h" | "7d" | "30d";

export type MonitoringRegion = "us-east-1" | "us-west-2" | "eu-west-1" | "ap-southeast-1";

export type ChannelType = "EMAIL" | "SLACK" | "WEBHOOK";

export type AlertEvent =
  | "INCIDENT_OPEN"
  | "INCIDENT_RESOLVED"
  | "SLO_BURN_RATE"
  | "LATENCY_BREACH"
  | "FAILURE_RATE_BREACH";

export type SimulationMode = "FORCE_FAIL" | "FORCE_DEGRADED" | "CLEAR";
export type AiRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AiAnomalyType = "NO_DATA" | "FAILURE_RATE" | "BURN_RATE" | "LATENCY";
export type AiAnomalySeverity = "LOW" | "MEDIUM" | "HIGH";

export type FailureClassification =
  | "HTTP_2XX_3XX"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "TIMEOUT"
  | "NETWORK"
  | "CIRCUIT_OPEN"
  | "SIMULATED_FORCE_FAIL"
  | "SIMULATED_FORCE_DEGRADED";

export interface RegionCircuitState {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  openedAtIso?: string;
  halfOpenAtIso?: string;
  nextAttemptAtIso?: string;
  consecutiveFailures: number;
}

export interface SimulationState {
  mode: Exclude<SimulationMode, "CLEAR">;
  appliedAtIso: string;
  expiresAtIso?: string | null;
  failureStatusCode?: number;
  forcedLatencyMs?: number;
}

export interface SimulationRequest {
  mode: SimulationMode;
  failureStatusCode?: number;
  forcedLatencyMs?: number;
  durationMinutes?: number;
}

export interface SimulationResponse {
  endpointId: string;
  mode: SimulationMode;
  appliedAtIso: string;
  expiresAtIso: string | null;
}

export interface Organization {
  orgId: string;
  name: string;
  createdAt: string;
  endpointLimit: number;
  isActive: boolean;
}

export interface CloneDemoOrganizationResult {
  organization: Organization;
  sourceEndpointCount: number;
  clonedEndpointCount: number;
  failedEndpointNames: string[];
}

export interface CleanupSandboxOrganizationResult {
  orgId: string;
  deleted: {
    organizations: number;
    memberships: number;
    endpoints: number;
    probeResults: number;
    incidents: number;
    alertChannels: number;
    webhookSecrets: number;
    wsConnections: number;
  };
}

export interface Membership {
  orgId: string;
  userId: string;
  email: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
}

export interface Endpoint {
  orgId: string;
  endpointId: string;
  name: string;
  url: string;
  protocol: EndpointProtocol;
  timeoutMs: number;
  tags: string[];
  status: EndpointStatus;
  createdAt: string;
  updatedAt: string;
  paused: boolean;
  lastCheckedAt?: string;
  lastStatusCode?: number;
  lastLatencyMs?: number;
  consecutiveFailures: number;
  checkRegions: MonitoringRegion[];
  regionFailures: Partial<Record<MonitoringRegion, number>>;
  slaTargetPct: number;
  latencyThresholdMs?: number;
  failureRateThresholdPct?: number;
  regionCircuitState?: Partial<Record<MonitoringRegion, RegionCircuitState>>;
  simulation?: SimulationState;
}

export interface ProbeResult {
  orgId: string;
  endpointId: string;
  region: MonitoringRegion;
  timestampIso: string;
  statusCode?: number;
  latencyMs?: number;
  ok: boolean;
  errorType?: string;
  classification?: FailureClassification;
  simulated?: boolean;
  traceId?: string;
  expiresAt: number;
}

export interface Incident {
  incidentId: string;
  orgId: string;
  endpointId: string;
  region?: MonitoringRegion;
  state: IncidentState;
  openedAt: string;
  resolvedAt?: string;
  failureCount: number;
  latestError?: string;
}

export interface AlertChannel {
  orgId: string;
  channelId: string;
  name?: string;
  type: ChannelType;
  target: string;
  events?: AlertEvent[];
  secretHeaderName?: string;
  verified: boolean;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LatencyStats {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface EndpointMetrics {
  endpointId: string;
  window: MetricsWindow;
  uptimePct: number;
  failureRatePct: number;
  checks: number;
  success: number;
  failure: number;
  latency: LatencyStats;
  slaTargetPct: number;
  slaMet: boolean;
  burnRate: number;
  burnRateAlert: boolean;
  latencyThresholdMs?: number;
  latencyThresholdBreached?: boolean;
  failureRateThresholdPct?: number;
  failureRateThresholdBreached?: boolean;
  errorBudgetRemainingPct: number;
  byRegion: Array<{
    region: MonitoringRegion;
    checks: number;
    uptimePct: number;
    avgLatencyMs: number;
  }>;
}

export interface EndpointSlaReport {
  endpointId: string;
  window: MetricsWindow;
  periodStartIso: string;
  periodEndIso: string;
  targetSlaPct: number;
  achievedSlaPct: number | null;
  errorBudgetMinutes: number;
  errorBudgetRemainingMinutes: number;
  burnRate: number;
  burnRateAlert: boolean;
  totalChecks: number;
  failedChecks: number;
}

export interface IncidentTimelineEvent {
  ts: string;
  type:
    | "INCIDENT_OPENED"
    | "INCIDENT_RESOLVED"
    | "PROBE_FAILED"
    | "PROBE_RECOVERED"
    | "ALERT_SENT";
  message: string;
  region?: MonitoringRegion;
  statusCode?: number;
  latencyMs?: number;
  errorType?: string;
  channel?: ChannelType;
  correlationId?: string;
}

export interface IncidentTimeline {
  incidentId: string;
  orgId: string;
  endpointId: string;
  region?: MonitoringRegion;
  state: IncidentState;
  openedAt: string;
  resolvedAt?: string;
  events: IncidentTimelineEvent[];
}

export interface OrgAiEndpointAnomaly {
  endpointId: string;
  endpointName: string;
  type: AiAnomalyType;
  severity: AiAnomalySeverity;
  message: string;
  checks: number;
  failureRatePct: number;
  burnRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface OrgAiEndpointRisk {
  endpointId: string;
  endpointName: string;
  riskScore: number;
  reasons: string[];
}

export interface OrgAiInsights {
  orgId: string;
  window: MetricsWindow;
  model: string;
  generatedAt: string;
  riskLevel: AiRiskLevel;
  summary: string;
  totals: {
    endpoints: number;
    checks: number;
    failedChecks: number;
    failureRatePct: number;
    avgBurnRate: number;
  };
  anomalies: OrgAiEndpointAnomaly[];
  recommendations: string[];
  topAtRiskEndpoints: OrgAiEndpointRisk[];
}

export interface DashboardSummary {
  orgId: string;
  window: MetricsWindow;
  totalEndpoints: number;
  healthyEndpoints: number;
  degradedEndpoints: number;
  downEndpoints: number;
  pausedEndpoints: number;
  uptimePct: number;
  failureRatePct: number;
  burnRate: number;
  burnRateAlert: boolean;
  sparkline: Array<{ t: string; uptimePct: number }>;
  burnRateSparkline: Array<{ t: string; burnRate: number }>;
}

export interface PaginationCursor {
  nextCursor?: string;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, string | number | boolean>;
}

export interface HealthUpdateEvent {
  orgId: string;
  endpointId: string;
  region: MonitoringRegion;
  ts: string;
  status: EndpointStatus;
  latencyMs?: number;
  statusCode?: number;
  incidentState: IncidentState | "NONE";
}

export interface IncidentUpdateEvent {
  orgId: string;
  endpointId: string;
  region?: MonitoringRegion;
  incidentId: string;
  state: IncidentState;
  openedAt: string;
  resolvedAt?: string;
}
