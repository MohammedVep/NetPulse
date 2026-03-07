import type {
  AlertEvent,
  EndpointStatus,
  FailureClassification,
  SimulationState,
  IncidentState,
  MonitoringRegion
} from "@netpulse/shared";

export interface ProbeJob {
  orgId: string;
  endpointId: string;
  url: string;
  timeoutMs: number;
  region: MonitoringRegion;
  traceId?: string;
  simulation?: SimulationState;
}

export interface ProbeExecution {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  errorType?: string;
  classification?: FailureClassification;
  timestampIso: string;
  region: MonitoringRegion;
  simulated?: boolean;
  simulationMode?: SimulationState["mode"];
  traceId?: string;
  attemptCount?: number;
}

export interface WsEvent {
  type: "health_update" | "incident_update";
  orgId: string;
  endpointId: string;
  payload: {
    region?: MonitoringRegion;
    ts?: string;
    status?: EndpointStatus;
    latencyMs?: number;
    statusCode?: number;
    incidentState?: IncidentState | "NONE";
    incidentId?: string;
    state?: IncidentState;
    openedAt?: string;
    resolvedAt?: string;
  };
}

export interface IncidentNotificationEvent {
  orgId: string;
  endpointId: string;
  region?: MonitoringRegion;
  incidentId: string;
  state: IncidentState;
  correlationId: string;
  traceId?: string;
  alertEvent?: AlertEvent;
  message?: string;
  metrics?: {
    checks?: number;
    failures?: number;
    failureRatePct?: number;
    avgLatencyMs?: number;
    burnRate?: number;
    threshold?: number;
  };
  openedAt: string;
  resolvedAt?: string;
}
