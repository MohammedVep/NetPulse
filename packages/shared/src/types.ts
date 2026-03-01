export type Role = "Owner" | "Admin" | "Editor" | "Viewer";

export type EndpointProtocol = "HTTP" | "HTTPS";

export type EndpointStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "PAUSED" | "DELETED";

export type IncidentState = "OPEN" | "RESOLVED";

export type MetricsWindow = "24h" | "7d" | "30d";

export type MonitoringRegion = "us-east-1" | "us-west-2" | "eu-west-1" | "ap-southeast-1";

export type ChannelType = "EMAIL" | "SLACK" | "WEBHOOK";

export type FailureSimulationMode = "NONE" | "FORCE_FAIL" | "FLAKY" | "LATENCY_SPIKE";

export interface FailureSimulation {
  mode: FailureSimulationMode;
  until?: string;
  failureRatePct?: number;
  extraLatencyMs?: number;
}

export interface Organization {
  orgId: string;
  name: string;
  createdAt: string;
  endpointLimit: number;
  isActive: boolean;
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
  simulation?: FailureSimulation;
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
  simulated?: boolean;
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
  type: ChannelType;
  target: string;
  verified: boolean;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LatencyStats {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface EndpointMetrics {
  endpointId: string;
  window: MetricsWindow;
  uptimePct: number;
  checks: number;
  success: number;
  failure: number;
  latency: LatencyStats;
  slaTargetPct: number;
  slaMet: boolean;
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
  uptimePct: number;
  checks: number;
  failures: number;
  slaTargetPct: number;
  slaMet: boolean;
  errorBudgetRemainingPct: number;
  remainingDowntimeMinutes: number;
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
  sparkline: Array<{ t: string; uptimePct: number }>;
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
