export const env = {
  organizationsTable: process.env.ORGANIZATIONS_TABLE ?? "np_organizations",
  endpointsTable: process.env.ENDPOINTS_TABLE ?? "np_endpoints",
  probeResultsTable: process.env.PROBE_RESULTS_TABLE ?? "np_probe_results",
  incidentsTable: process.env.INCIDENTS_TABLE ?? "np_incidents",
  wsConnectionsTable: process.env.WS_CONNECTIONS_TABLE ?? "np_ws_connections",
  alertChannelsTable: process.env.ALERT_CHANNELS_TABLE ?? "np_alert_channels",
  alertDedupeTable: process.env.ALERT_DEDUPE_TABLE ?? "np_alert_dedupe",
  probeQueueUrl: process.env.PROBE_JOBS_QUEUE_URL ?? "",
  incidentEventsQueueUrl: process.env.INCIDENT_EVENTS_QUEUE_URL ?? "",
  wsEventsQueueUrl: process.env.WS_EVENTS_QUEUE_URL ?? "",
  monthlyReportsBucket: process.env.MONTHLY_REPORTS_BUCKET ?? "",
  websocketEndpoint: process.env.WEBSOCKET_ENDPOINT ?? "",
  emailTopicArn: process.env.EMAIL_TOPIC_ARN ?? "",
  region: process.env.AWS_REGION ?? "us-east-1"
};
