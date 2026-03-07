export const env = {
  organizationsTable: process.env.ORGANIZATIONS_TABLE ?? "np_organizations",
  membershipsTable: process.env.MEMBERSHIPS_TABLE ?? "np_memberships",
  endpointsTable: process.env.ENDPOINTS_TABLE ?? "np_endpoints",
  probeResultsTable: process.env.PROBE_RESULTS_TABLE ?? "np_probe_results",
  incidentsTable: process.env.INCIDENTS_TABLE ?? "np_incidents",
  wsConnectionsTable: process.env.WS_CONNECTIONS_TABLE ?? "np_ws_connections",
  alertChannelsTable: process.env.ALERT_CHANNELS_TABLE ?? "np_alert_channels",
  rateLimitsTable: process.env.RATE_LIMITS_TABLE ?? "np_rate_limits",
  rateLimitWindowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? "60"),
  rateLimitPublicRpm: Number(process.env.RATE_LIMIT_PUBLIC_RPM ?? "60"),
  rateLimitAuthRpm: Number(process.env.RATE_LIMIT_AUTH_RPM ?? "300"),
  endpointLimitDefault: Number(process.env.ENDPOINT_LIMIT_DEFAULT ?? "2000"),
  simulationClearStrict: process.env.SIMULATION_CLEAR_STRICT === "true",
  publicDemoEnabled: process.env.PUBLIC_DEMO_ENABLED === "true",
  publicDemoOrgId: process.env.PUBLIC_DEMO_ORG_ID ?? "org_demo_public"
};
