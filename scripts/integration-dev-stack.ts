import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

interface CliOptions {
  env: string;
  region: string;
  profile: string;
  adminProfile: string;
}

interface DrillConfig {
  email: string;
  slackWebhookUrl: string;
  webhookUrl: string;
  webhookSecretValue?: string;
}

interface ApiResponse<T = unknown> {
  status: number;
  text: string;
  json: T | null;
}

interface StackOutputs {
  apiBaseUrl: string;
  wsUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  emailTopicArn: string;
}

interface WsEnvelope {
  type: string;
  orgId: string;
  endpointId: string;
  state?: string;
}

interface ProbeJob {
  orgId: string;
  endpointId: string;
  url: string;
  timeoutMs: number;
  region: "us-east-1";
}

interface NotifierDeliveryLog {
  event: "incident_notifier_delivered";
  channel: "EMAIL" | "SLACK" | "WEBHOOK";
  state: "OPEN" | "RESOLVED";
  alertEvent?:
    | "INCIDENT_OPEN"
    | "INCIDENT_RESOLVED"
    | "SLO_BURN_RATE"
    | "LATENCY_BREACH"
    | "FAILURE_RATE_BREACH";
  orgId: string;
  endpointId: string;
  incidentId: string;
  correlationId: string;
  traceId?: string;
  statusCode: number;
  providerResponse?: string;
}

interface EndpointWithCircuitState {
  endpointId: string;
  regionCircuitState?: {
    "us-east-1"?: {
      state?: "CLOSED" | "OPEN" | "HALF_OPEN";
      nextAttemptAtIso?: string;
    };
  };
}

interface DrillReport {
  runId: string;
  startedAt: string;
  endedAt: string;
  orgId: string;
  endpointId: string;
  incidentOpenTs: string;
  incidentResolvedTs: string;
  fanoutResults: {
    open: {
      channels: Array<{ channel: string; correlationId: string; statusCode: number }>;
      correlationIdAligned: boolean;
    };
    resolved: {
      channels: Array<{ channel: string; correlationId: string; statusCode: number }>;
      correlationIdAligned: boolean;
    };
    derived: {
      failureRateBreach: Array<{ channel: string; correlationId: string; statusCode: number }>;
      burnRate: Array<{ channel: string; correlationId: string; statusCode: number }>;
      latencyBreach: Array<{ channel: string; correlationId: string; statusCode: number }>;
    };
  };
  timeline: unknown;
  slaBefore: unknown;
  slaAfter: unknown;
  pass: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    env: "dev",
    region: process.env.AWS_REGION ?? "us-east-1",
    profile: "netpulse-dev",
    adminProfile: process.env.NETPULSE_ADMIN_PROFILE ?? "netpulse-root"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --env");
      options.env = value;
      i += 1;
      continue;
    }

    if (arg === "--region") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --region");
      options.region = value;
      i += 1;
      continue;
    }

    if (arg === "--profile") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --profile");
      options.profile = value;
      i += 1;
      continue;
    }

    if (arg === "--admin-profile") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --admin-profile");
      options.adminProfile = value;
      i += 1;
    }
  }

  return options;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function resolveDrillConfig(): DrillConfig {
  return {
    email: requiredEnv("DRILL_EMAIL_ADDRESS"),
    slackWebhookUrl: requiredEnv("DRILL_SLACK_WEBHOOK_URL"),
    webhookUrl: requiredEnv("DRILL_WEBHOOK_RECEIVER_URL"),
    webhookSecretValue: process.env.DRILL_WEBHOOK_SECRET_VALUE?.trim() || undefined
  };
}

function runAws(args: string[], options: CliOptions, profileOverride?: string): string {
  const profile = profileOverride ?? options.profile;
  const result = spawnSync(
    "aws",
    [...args, "--region", options.region, "--profile", profile],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }
  );

  if (result.status !== 0) {
    throw new Error(`aws ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

function runAwsJson<T>(args: string[], options: CliOptions, profileOverride?: string): T {
  const output = runAws([...args, "--output", "json"], options, profileOverride);
  return JSON.parse(output) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function findOutput(outputs: Array<{ OutputKey: string; OutputValue: string }>, fragment: string): string {
  const output = outputs.find((item) => item.OutputKey.includes(fragment));
  if (!output) {
    throw new Error(`Could not find stack output containing ${fragment}`);
  }

  return output.OutputValue;
}

function resolveStackOutputs(options: CliOptions): StackOutputs {
  const stackName = `NetPulse-${options.env}`;
  const stack = runAwsJson<{ Stacks: Array<{ Outputs: Array<{ OutputKey: string; OutputValue: string }> }> }>(
    ["cloudformation", "describe-stacks", "--stack-name", stackName],
    options,
    options.profile
  );

  const outputs = stack.Stacks[0]?.Outputs ?? [];
  return {
    apiBaseUrl: findOutput(outputs, "NetPulseHttpApiUrl").replace(/\/$/, ""),
    wsUrl: findOutput(outputs, "NetPulseWebSocketUrl"),
    userPoolId: findOutput(outputs, "NetPulseUserPoolId"),
    userPoolClientId: findOutput(outputs, "NetPulseUserPoolClientId"),
    emailTopicArn: findOutput(outputs, "NetPulseEmailTopicArn")
  };
}

async function apiRequest<T = unknown>(
  apiBaseUrl: string,
  pathValue: string,
  method = "GET",
  token?: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  const response = await fetch(`${apiBaseUrl}${pathValue}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }

  return {
    status: response.status,
    text,
    json
  };
}

async function waitFor<T>(
  description: string,
  check: () => Promise<T | null> | T | null,
  timeoutMs = 120_000,
  intervalMs = 4_000
): Promise<T> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value !== null) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function createTempUser(
  userPoolId: string,
  options: CliOptions
): { username: string; password: string } {
  const username = `integration-${options.env}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@example.com`;
  const password = `Np!${options.env}${Date.now()}Aa1`;

  runAws(
    [
      "cognito-idp",
      "admin-create-user",
      "--user-pool-id",
      userPoolId,
      "--username",
      username,
      "--message-action",
      "SUPPRESS",
      "--user-attributes",
      `Name=email,Value=${username}`,
      "Name=email_verified,Value=true"
    ],
    options,
    options.adminProfile
  );

  runAws(
    [
      "cognito-idp",
      "admin-set-user-password",
      "--user-pool-id",
      userPoolId,
      "--username",
      username,
      "--password",
      password,
      "--permanent"
    ],
    options,
    options.adminProfile
  );

  return { username, password };
}

function deleteTempUser(userPoolId: string, username: string, options: CliOptions): void {
  try {
    runAws(
      [
        "cognito-idp",
        "admin-delete-user",
        "--user-pool-id",
        userPoolId,
        "--username",
        username
      ],
      options,
      options.adminProfile
    );
  } catch (error) {
    console.warn("cleanup warning: failed deleting temporary user", error);
  }
}

function getIdToken(
  userPoolClientId: string,
  username: string,
  password: string,
  options: CliOptions
): string {
  const token = runAws(
    [
      "cognito-idp",
      "initiate-auth",
      "--client-id",
      userPoolClientId,
      "--auth-flow",
      "USER_PASSWORD_AUTH",
      "--auth-parameters",
      `USERNAME=${username},PASSWORD=${password}`,
      "--query",
      "AuthenticationResult.IdToken",
      "--output",
      "text"
    ],
    options,
    options.adminProfile
  ).trim();

  if (!token || token === "None") {
    throw new Error("Failed to obtain Cognito IdToken");
  }

  return token;
}

function invokeWorkerJob(job: ProbeJob, options: CliOptions): void {
  const functionName = `np-probe-worker-${options.env}`;
  const payload = {
    Records: [
      {
        messageId: `integration-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
        body: JSON.stringify(job)
      }
    ]
  };

  runAws(
    [
      "lambda",
      "invoke",
      "--function-name",
      functionName,
      "--cli-binary-format",
      "raw-in-base64-out",
      "--payload",
      JSON.stringify(payload),
      "/dev/null"
    ],
    options,
    options.adminProfile
  );
}

function notifierFailureCount(startMs: number, options: CliOptions): number {
  const logGroupName = `/aws/lambda/np-incident-notifier-${options.env}`;
  const result = runAwsJson<{ events?: unknown[] }>(
    [
      "logs",
      "filter-log-events",
      "--log-group-name",
      logGroupName,
      "--start-time",
      String(startMs),
      "--filter-pattern",
      "incident notifier failed"
    ],
    options,
    options.adminProfile
  );

  return result.events?.length ?? 0;
}

function assertConfirmedEmailSubscription(topicArn: string, email: string, options: CliOptions): void {
  const result = runAwsJson<{
    Subscriptions?: Array<{ Endpoint?: string; Protocol?: string; SubscriptionArn?: string }>;
  }>(
    ["sns", "list-subscriptions-by-topic", "--topic-arn", topicArn],
    options,
    options.adminProfile
  );

  const matched = (result.Subscriptions ?? []).find(
    (subscription) => subscription.Protocol === "email" && subscription.Endpoint?.toLowerCase() === email.toLowerCase()
  );

  if (!matched) {
    throw new Error(
      `No SNS email subscription found for ${email}. Subscribe the email to ${topicArn} and confirm it, then rerun.`
    );
  }

  if (!matched.SubscriptionArn || matched.SubscriptionArn === "PendingConfirmation") {
    throw new Error(`SNS email subscription for ${email} is pending confirmation`);
  }
}

function openWebSocket(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket connection timeout"));
    }, 20_000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection error"));
    });
  });
}

function parseNotifierLine(message: string): NotifierDeliveryLog | null {
  const trimmed = message.trim();
  if (!trimmed.includes("incident_notifier_delivered")) {
    return null;
  }

  const startIndex = trimmed.indexOf("{");
  const jsonCandidate = startIndex >= 0 ? trimmed.slice(startIndex) : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as NotifierDeliveryLog;
    if (parsed.event !== "incident_notifier_delivered") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function listNotifierDeliveries(startMs: number, options: CliOptions): NotifierDeliveryLog[] {
  const logGroupName = `/aws/lambda/np-incident-notifier-${options.env}`;
  const result = runAwsJson<{ events?: Array<{ message?: string }> }>(
    [
      "logs",
      "filter-log-events",
      "--log-group-name",
      logGroupName,
      "--start-time",
      String(startMs),
      "--filter-pattern",
      "incident_notifier_delivered"
    ],
    options,
    options.adminProfile
  );

  const parsed = (result.events ?? [])
    .map((event) => (event.message ? parseNotifierLine(event.message) : null))
    .filter((event): event is NotifierDeliveryLog => event !== null);

  return parsed;
}

async function waitForFanout(
  startMs: number,
  state: "OPEN" | "RESOLVED",
  alertEvent:
    | "INCIDENT_OPEN"
    | "INCIDENT_RESOLVED"
    | "SLO_BURN_RATE"
    | "LATENCY_BREACH"
    | "FAILURE_RATE_BREACH",
  orgId: string,
  endpointId: string,
  options: CliOptions
): Promise<Array<{ channel: string; correlationId: string; statusCode: number }>> {
  return waitFor(
    `fanout ${state}`,
    async () => {
      const deliveries = listNotifierDeliveries(startMs, options).filter(
        (event) =>
          event.state === state &&
          event.alertEvent === alertEvent &&
          event.orgId === orgId &&
          event.endpointId === endpointId &&
          ["EMAIL", "SLACK", "WEBHOOK"].includes(event.channel) &&
          event.statusCode >= 200 &&
          event.statusCode < 300
      );

      const channels = ["EMAIL", "SLACK", "WEBHOOK"] as const;
      const complete = channels.every((channel) => deliveries.some((entry) => entry.channel === channel));
      if (!complete) {
        return null;
      }

      const reduced = channels.map((channel) => {
        const latest = deliveries.filter((item) => item.channel === channel).at(-1)!;
        return {
          channel,
          correlationId: latest.correlationId,
          statusCode: latest.statusCode
        };
      });

      return reduced;
    },
    240_000,
    5_000
  );
}

function writeDrillReport(report: DrillReport): string {
  const root = path.resolve(process.cwd(), "artifacts", "drills");
  mkdirSync(root, { recursive: true });

  const fileName = `${report.runId}.json`;
  const filePath = path.join(root, fileName);
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

async function waitForCircuitRetryWindow(
  apiBaseUrl: string,
  endpointId: string,
  token: string
): Promise<void> {
  const endpointResponse = await apiRequest<EndpointWithCircuitState>(
    apiBaseUrl,
    `/v1/endpoints/${encodeURIComponent(endpointId)}`,
    "GET",
    token
  );

  if (endpointResponse.status !== 200 || !endpointResponse.json) {
    return;
  }

  const nextAttemptAtIso = endpointResponse.json.regionCircuitState?.["us-east-1"]?.nextAttemptAtIso;
  if (!nextAttemptAtIso) {
    return;
  }

  const waitMs = Date.parse(nextAttemptAtIso) - Date.now();
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs + 1_500));
  }
}

function assertSlaSchema(payload: unknown): void {
  const report = payload as Record<string, unknown> | null;
  assert(report && typeof report === "object", "SLA response must be an object");
  const requiredFields = [
    "endpointId",
    "window",
    "periodStartIso",
    "periodEndIso",
    "targetSlaPct",
    "achievedSlaPct",
    "errorBudgetMinutes",
    "errorBudgetRemainingMinutes",
    "totalChecks",
    "failedChecks"
  ];

  for (const field of requiredFields) {
    assert(field in report, `SLA response missing field: ${field}`);
  }
}

function assertTimelineSchema(payload: unknown): void {
  const timeline = payload as Record<string, unknown> | null;
  assert(timeline && typeof timeline === "object", "Timeline response must be an object");
  const requiredFields = ["incidentId", "orgId", "endpointId", "state", "openedAt", "events"];
  for (const field of requiredFields) {
    assert(field in timeline, `Timeline response missing field: ${field}`);
  }

  const events = timeline.events as unknown;
  assert(Array.isArray(events), "Timeline events must be an array");
  for (const event of events) {
    const item = event as Record<string, unknown>;
    assert(item && typeof item === "object", "Timeline event must be an object");
    assert(typeof item.ts === "string", "Timeline event must include ts");
    assert(typeof item.type === "string", "Timeline event must include type");
    assert(typeof item.message === "string", "Timeline event must include message");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const drillConfig = resolveDrillConfig();
  const startMs = Date.now();
  const outputs = resolveStackOutputs(options);
  const skipEmailSubscriptionCheck = process.env.DRILL_SKIP_EMAIL_SUBSCRIPTION_CHECK === "true";
  if (!skipEmailSubscriptionCheck) {
    assertConfirmedEmailSubscription(outputs.emailTopicArn, drillConfig.email, options);
  } else {
    console.warn("Skipping SNS email subscription confirmation check (DRILL_SKIP_EMAIL_SUBSCRIPTION_CHECK=true).");
  }

  console.log(`Running deployed integration drill for env=${options.env}`);
  console.log(`API: ${outputs.apiBaseUrl}`);
  console.log(`WS: ${outputs.wsUrl}`);

  const unauth = await apiRequest(outputs.apiBaseUrl, "/v1/endpoints?orgId=integration");
  assert(unauth.status === 401, `Expected unauthenticated 401, got ${unauth.status}`);

  const { username, password } = createTempUser(outputs.userPoolId, options);
  const token = getIdToken(outputs.userPoolClientId, username, password, options);

  let endpointId: string | null = null;
  let orgId: string | null = null;
  let incidentId: string | null = null;
  let incidentOpenedAt = "";
  let incidentResolvedAt = "";
  let timelinePayload: unknown = null;
  let slaBefore: unknown = null;
  let slaAfter: unknown = null;

  const wsMessages: WsEnvelope[] = [];
  let ws: WebSocket | null = null;

  try {
    const orgCreate = await apiRequest<{ orgId: string }>(
      outputs.apiBaseUrl,
      "/v1/organizations",
      "POST",
      token,
      {
        name: `Integration ${options.env} ${new Date().toISOString()}`
      }
    );
    assert(orgCreate.status === 201, `Organization create failed: ${orgCreate.status} ${orgCreate.text}`);
    assert(orgCreate.json?.orgId, "Organization create response missing orgId");
    orgId = orgCreate.json.orgId;
    console.log(`Created org: ${orgId}`);

    ws = await openWebSocket(outputs.wsUrl);
    ws.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as WsEnvelope;
        wsMessages.push(parsed);
      } catch {
        // ignore malformed event payloads
      }
    });

    ws.send(
      JSON.stringify({
        action: "subscribe",
        orgId,
        token
      })
    );

    const endpointUrl = `${outputs.apiBaseUrl}/v1/public/dashboard/summary?orgId=org_demo_public&window=24h`;

    const invalidWebhook = await apiRequest(
      outputs.apiBaseUrl,
      "/v1/alert-channels/webhook",
      "POST",
      token,
      {
        orgId,
        name: "Invalid Channel",
        url: "http://localhost/hook",
        events: ["INCIDENT_OPEN"]
      }
    );
    assert(invalidWebhook.status === 400, `Invalid webhook URL should fail with 400, got ${invalidWebhook.status}`);

    const emailChannel = await apiRequest(outputs.apiBaseUrl, "/v1/alert-channels/email", "POST", token, {
      orgId,
      email: drillConfig.email
    });
    assert(emailChannel.status === 201, `Email channel create failed: ${emailChannel.status} ${emailChannel.text}`);

    const slackChannel = await apiRequest(outputs.apiBaseUrl, "/v1/alert-channels/slack", "POST", token, {
      orgId,
      webhookUrl: drillConfig.slackWebhookUrl
    });
    assert(slackChannel.status === 201, `Slack channel create failed: ${slackChannel.status} ${slackChannel.text}`);

    const webhookChannel = await apiRequest(outputs.apiBaseUrl, "/v1/alert-channels/webhook", "POST", token, {
      orgId,
      name: "Dev Drill Webhook",
      url: drillConfig.webhookUrl,
      events: [
        "INCIDENT_OPEN",
        "INCIDENT_RESOLVED",
        "SLO_BURN_RATE",
        "LATENCY_BREACH",
        "FAILURE_RATE_BREACH"
      ],
      ...(drillConfig.webhookSecretValue
        ? {
            secretHeaderName: "x-netpulse-signature",
            secretHeaderValue: drillConfig.webhookSecretValue
          }
        : {})
    });
    assert(webhookChannel.status === 201, `Webhook channel create failed: ${webhookChannel.status} ${webhookChannel.text}`);

    const endpointCreate = await apiRequest<{ endpointId: string }>(outputs.apiBaseUrl, "/v1/endpoints", "POST", token, {
      orgId,
      name: "Integration Endpoint",
      url: endpointUrl,
      timeoutMs: 6000,
      tags: ["integration", options.env],
      checkRegions: ["us-east-1"],
      slaTargetPct: 99.99,
      failureRateThresholdPct: 1,
      latencyThresholdMs: 1200
    });
    assert(
      endpointCreate.status === 201,
      `Endpoint create failed: ${endpointCreate.status} ${endpointCreate.text}`
    );
    assert(endpointCreate.json?.endpointId, "Endpoint create response missing endpointId");
    endpointId = endpointCreate.json.endpointId;
    console.log(`Created endpoint: ${endpointId}`);

    for (const windowValue of ["24h", "7d", "30d"] as const) {
      const slaCheck = await apiRequest(outputs.apiBaseUrl, `/v1/endpoints/${encodeURIComponent(endpointId)}/sla?window=${windowValue}`, "GET", token);
      assert(slaCheck.status === 200, `SLA ${windowValue} failed: ${slaCheck.status} ${slaCheck.text}`);
      assertSlaSchema(slaCheck.json);
      if (windowValue === "24h") {
        slaBefore = slaCheck.json;
      }
    }

    const invalidSim = await apiRequest(
      outputs.apiBaseUrl,
      `/v1/endpoints/${encodeURIComponent(endpointId)}/simulate`,
      "POST",
      token,
      { mode: "BAD_MODE" }
    );
    assert(invalidSim.status === 400, `Invalid simulation mode should fail with 400, got ${invalidSim.status}`);

    const simulationSet = await apiRequest(outputs.apiBaseUrl, `/v1/endpoints/${encodeURIComponent(endpointId)}/simulate`, "POST", token, {
      mode: "FORCE_FAIL",
      failureStatusCode: 503,
      durationMinutes: 15
    });
    assert(simulationSet.status === 200, `Set simulation failed: ${simulationSet.status} ${simulationSet.text}`);

    const job: ProbeJob = {
      orgId,
      endpointId,
      url: endpointUrl,
      timeoutMs: 6000,
      region: "us-east-1"
    };

    invokeWorkerJob(job, options);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    invokeWorkerJob(job, options);

    const openIncident = await waitFor(
      "incident OPEN",
      async () => {
        const incidents = await apiRequest<{
          items: Array<{ incidentId: string; endpointId: string; state: string; openedAt: string }>;
        }>(
          outputs.apiBaseUrl,
          `/v1/incidents?orgId=${encodeURIComponent(orgId)}&status=open`,
          "GET",
          token
        );

        if (incidents.status !== 200 || !incidents.json) {
          return null;
        }

        return incidents.json.items.find((item) => item.endpointId === endpointId && item.state === "OPEN") ?? null;
      },
      90_000,
      3_000
    );
    incidentId = openIncident.incidentId;
    incidentOpenedAt = openIncident.openedAt;

    await waitFor(
      "websocket incident OPEN event",
      async () =>
        wsMessages.find(
          (message) =>
            message.type === "incident_update" &&
            message.endpointId === endpointId &&
            message.state === "OPEN"
        ) ?? null,
      90_000,
      2_000
    );

    const openFanout = await waitForFanout(
      startMs,
      "OPEN",
      "INCIDENT_OPEN",
      orgId,
      endpointId,
      options
    );

    for (let i = 0; i < 1; i += 1) {
      invokeWorkerJob(job, options);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    const failureRateFanout = await waitForFanout(
      startMs,
      "OPEN",
      "FAILURE_RATE_BREACH",
      orgId,
      endpointId,
      options
    );
    const burnRateFanout = await waitForFanout(
      startMs,
      "OPEN",
      "SLO_BURN_RATE",
      orgId,
      endpointId,
      options
    );

    const clearSimulation = await apiRequest(
      outputs.apiBaseUrl,
      `/v1/endpoints/${encodeURIComponent(endpointId)}/simulate`,
      "POST",
      token,
      { mode: "CLEAR" }
    );
    assert(clearSimulation.status === 200, `Clear simulation failed: ${clearSimulation.status} ${clearSimulation.text}`);

    await waitForCircuitRetryWindow(outputs.apiBaseUrl, endpointId, token);
    invokeWorkerJob(job, options);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const resolvedIncident = await waitFor(
      "incident RESOLVED",
      async () => {
        const incidents = await apiRequest<{
          items: Array<{ incidentId: string; endpointId: string; state: string; resolvedAt: string }>;
        }>(
          outputs.apiBaseUrl,
          `/v1/incidents?orgId=${encodeURIComponent(orgId)}&status=resolved`,
          "GET",
          token
        );

        if (incidents.status !== 200 || !incidents.json) {
          return null;
        }

        return incidents.json.items.find((item) => item.endpointId === endpointId && item.state === "RESOLVED") ?? null;
      },
      120_000,
      4_000
    );
    incidentResolvedAt = resolvedIncident.resolvedAt;

    await waitFor(
      "websocket incident RESOLVED event",
      async () =>
        wsMessages.find(
          (message) =>
            message.type === "incident_update" &&
            message.endpointId === endpointId &&
            message.state === "RESOLVED"
        ) ?? null,
      90_000,
      2_000
    );

    const resolvedFanout = await waitForFanout(
      startMs,
      "RESOLVED",
      "INCIDENT_RESOLVED",
      orgId,
      endpointId,
      options
    );

    const setLatencySimulation = await apiRequest(
      outputs.apiBaseUrl,
      `/v1/endpoints/${encodeURIComponent(endpointId)}/simulate`,
      "POST",
      token,
      {
        mode: "FORCE_DEGRADED",
        forcedLatencyMs: 5000,
        durationMinutes: 10
      }
    );
    assert(
      setLatencySimulation.status === 200,
      `Set latency simulation failed: ${setLatencySimulation.status} ${setLatencySimulation.text}`
    );

    for (let i = 0; i < 3; i += 1) {
      invokeWorkerJob(job, options);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    const latencyBreachFanout = await waitForFanout(
      startMs,
      "OPEN",
      "LATENCY_BREACH",
      orgId,
      endpointId,
      options
    );

    const clearLatencySimulation = await apiRequest(
      outputs.apiBaseUrl,
      `/v1/endpoints/${encodeURIComponent(endpointId)}/simulate`,
      "POST",
      token,
      { mode: "CLEAR" }
    );
    assert(
      clearLatencySimulation.status === 200,
      `Clear latency simulation failed: ${clearLatencySimulation.status} ${clearLatencySimulation.text}`
    );
    invokeWorkerJob(job, options);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const openCorrelationAligned = new Set(openFanout.map((entry) => entry.correlationId)).size === 1;
    const resolvedCorrelationAligned = new Set(resolvedFanout.map((entry) => entry.correlationId)).size === 1;

    assert(openCorrelationAligned, "OPEN fanout correlation IDs did not match across EMAIL/SLACK/WEBHOOK");
    assert(resolvedCorrelationAligned, "RESOLVED fanout correlation IDs did not match across EMAIL/SLACK/WEBHOOK");
    assert(
      new Set(failureRateFanout.map((entry) => entry.correlationId)).size === 1,
      "FAILURE_RATE_BREACH fanout correlation IDs did not match across EMAIL/SLACK/WEBHOOK"
    );
    assert(
      new Set(burnRateFanout.map((entry) => entry.correlationId)).size === 1,
      "SLO_BURN_RATE fanout correlation IDs did not match across EMAIL/SLACK/WEBHOOK"
    );
    assert(
      new Set(latencyBreachFanout.map((entry) => entry.correlationId)).size === 1,
      "LATENCY_BREACH fanout correlation IDs did not match across EMAIL/SLACK/WEBHOOK"
    );

    const notifierFailures = notifierFailureCount(startMs, options);
    assert(notifierFailures === 0, `Notifier failure logs detected: ${notifierFailures}`);

    assert(incidentId, "Incident ID missing for timeline verification");
    const timelineResponse = await apiRequest(
      outputs.apiBaseUrl,
      `/v1/incidents/${encodeURIComponent(incidentId)}/timeline?limit=200`,
      "GET",
      token
    );
    assert(
      timelineResponse.status === 200,
      `Incident timeline fetch failed: ${timelineResponse.status} ${timelineResponse.text}`
    );
    assertTimelineSchema(timelineResponse.json);
    timelinePayload = timelineResponse.json;
    const timelineEvents = (((timelineResponse.json as { events?: unknown[] } | null)?.events ??
      []) as Array<{ type?: string }>);
    const timelineTypes = new Set(timelineEvents.map((event) => event.type));
    assert(timelineTypes.has("INCIDENT_OPENED"), "Timeline missing INCIDENT_OPENED");
    assert(timelineTypes.has("INCIDENT_RESOLVED"), "Timeline missing INCIDENT_RESOLVED");
    assert(timelineTypes.has("PROBE_FAILED"), "Timeline missing PROBE_FAILED");
    assert(timelineTypes.has("ALERT_SENT"), "Timeline missing ALERT_SENT");

    const slaAfterResponse = await apiRequest(
      outputs.apiBaseUrl,
      `/v1/endpoints/${encodeURIComponent(endpointId)}/sla?window=24h`,
      "GET",
      token
    );
    assert(
      slaAfterResponse.status === 200,
      `SLA after simulation failed: ${slaAfterResponse.status} ${slaAfterResponse.text}`
    );
    assertSlaSchema(slaAfterResponse.json);
    slaAfter = slaAfterResponse.json;

    const drillReport: DrillReport = {
      runId: `drill-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date().toISOString(),
      orgId,
      endpointId,
      incidentOpenTs: incidentOpenedAt,
      incidentResolvedTs: incidentResolvedAt,
      fanoutResults: {
        open: {
          channels: openFanout,
          correlationIdAligned: openCorrelationAligned
        },
        resolved: {
          channels: resolvedFanout,
          correlationIdAligned: resolvedCorrelationAligned
        },
        derived: {
          failureRateBreach: failureRateFanout,
          burnRate: burnRateFanout,
          latencyBreach: latencyBreachFanout
        }
      },
      timeline: timelinePayload,
      slaBefore,
      slaAfter,
      pass: true
    };

    const reportPath = writeDrillReport(drillReport);

    console.log("Integration checks passed:");
    console.log(`- org creation: ${orgId}`);
    console.log(`- endpoint probe cycle + incident open/resolve: ${endpointId}`);
    console.log("- route checks: /sla /simulate /alert-channels/webhook /incidents/{id}/timeline");
    console.log("- notifier fanout verified: incident + failure-rate + burn-rate + latency alerts");
    console.log(`- drill report: ${reportPath}`);
    console.log("Distributed uptime monitor drill: incident open/resolve + multi-channel fanout verified.");
  } finally {
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }

    if (endpointId) {
      try {
        await apiRequest(
          outputs.apiBaseUrl,
          `/v1/endpoints/${encodeURIComponent(endpointId)}`,
          "DELETE",
          token
        );
      } catch (error) {
        console.warn("cleanup warning: failed deleting endpoint", error);
      }
    }

    deleteTempUser(outputs.userPoolId, username, options);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
