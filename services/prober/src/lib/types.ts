import type {
  EndpointStatus,
  FailureSimulation,
  IncidentState,
  MonitoringRegion
} from "@netpulse/shared";

export interface ProbeJob {
  orgId: string;
  endpointId: string;
  url: string;
  timeoutMs: number;
  region: MonitoringRegion;
  simulation?: FailureSimulation;
}

export interface ProbeExecution {
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  errorType?: string;
  timestampIso: string;
  region: MonitoringRegion;
  simulated?: boolean;
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
  openedAt: string;
  resolvedAt?: string;
}
