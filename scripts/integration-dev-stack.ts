import { spawnSync } from "node:child_process";
import process from "node:process";

interface CliOptions {
  env: string;
  region: string;
  profile: string;
  adminProfile: string;
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
    userPoolClientId: findOutput(outputs, "NetPulseUserPoolClientId")
  };
}

async function apiRequest<T = unknown>(
  apiBaseUrl: string,
  path: string,
  method = "GET",
  token?: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
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

function dedupeCount(prefix: string, options: CliOptions): number {
  const tableName = `np_alert_dedupe_${options.env}`;
  const count = runAws(
    [
      "dynamodb",
      "scan",
      "--table-name",
      tableName,
      "--filter-expression",
      "begins_with(dedupeKey, :prefix)",
      "--expression-attribute-values",
      JSON.stringify({
        ":prefix": {
          S: prefix
        }
      }),
      "--query",
      "Count",
      "--output",
      "text"
    ],
    options,
    options.adminProfile
  );

  const parsed = Number(count);
  return Number.isFinite(parsed) ? parsed : 0;
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startMs = Date.now();
  const outputs = resolveStackOutputs(options);

  console.log(`Running deployed integration for env=${options.env}`);
  console.log(`API: ${outputs.apiBaseUrl}`);
  console.log(`WS: ${outputs.wsUrl}`);

  const unauth = await apiRequest(outputs.apiBaseUrl, "/v1/endpoints?orgId=integration");
  assert(unauth.status === 401, `Expected unauthenticated 401, got ${unauth.status}`);

  const { username, password } = createTempUser(outputs.userPoolId, options);
  const token = getIdToken(outputs.userPoolClientId, username, password, options);

  let endpointId: string | null = null;
  let orgId: string | null = null;
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

    const callbackUrl = `${outputs.apiBaseUrl}/v1/public/dashboard/summary?orgId=org_demo_public&window=24h`;

    const emailChannel = await apiRequest(outputs.apiBaseUrl, "/v1/alert-channels/email", "POST", token, {
      orgId,
      email: `alerts-${Date.now()}@example.com`
    });
    assert(emailChannel.status === 201, `Email channel create failed: ${emailChannel.status} ${emailChannel.text}`);

    const slackChannel = await apiRequest(outputs.apiBaseUrl, "/v1/alert-channels/slack", "POST", token, {
      orgId,
      webhookUrl: callbackUrl
    });
    assert(slackChannel.status === 201, `Slack channel create failed: ${slackChannel.status} ${slackChannel.text}`);

    const webhookChannel = await apiRequest(outputs.apiBaseUrl, "/v1/alert-channels/webhook", "POST", token, {
      orgId,
      webhookUrl: callbackUrl
    });
    assert(webhookChannel.status === 201, `Webhook channel create failed: ${webhookChannel.status} ${webhookChannel.text}`);

    const endpointUrl = callbackUrl;
    const endpointCreate = await apiRequest<{ endpointId: string }>(outputs.apiBaseUrl, "/v1/endpoints", "POST", token, {
      orgId,
      name: "Integration Endpoint",
      url: endpointUrl,
      timeoutMs: 6000,
      tags: ["integration", options.env],
      checkRegions: ["us-east-1"],
      slaTargetPct: 99.9
    });
    assert(
      endpointCreate.status === 201,
      `Endpoint create failed: ${endpointCreate.status} ${endpointCreate.text}`
    );
    assert(endpointCreate.json?.endpointId, "Endpoint create response missing endpointId");
    endpointId = endpointCreate.json.endpointId;
    console.log(`Created endpoint: ${endpointId}`);

    const simulationSet = await apiRequest(outputs.apiBaseUrl, `/v1/endpoints/${encodeURIComponent(endpointId)}/simulate`, "POST", token, {
      mode: "FORCE_FAIL"
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

    await waitFor(
      "incident OPEN",
      async () => {
        const incidents = await apiRequest<{ items: Array<{ endpointId: string; state: string }> }>(
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

    await waitFor(
      "probe results",
      async () => {
        const now = new Date();
        const from = new Date(now.getTime() - 60 * 60 * 1000);
        const response = await apiRequest<{ items: unknown[] }>(
          outputs.apiBaseUrl,
          `/v1/endpoints/${encodeURIComponent(endpointId)}/checks?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(now.toISOString())}`,
          "GET",
          token
        );

        if (response.status !== 200 || !response.json) {
          return null;
        }

        return response.json.items.length >= 2 ? response.json.items : null;
      },
      90_000,
      3_000
    );

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

    await waitFor(
      "alert dedupe OPEN entries",
      async () => {
        const count = dedupeCount(`${orgId}:${endpointId}:us-east-1:OPEN:`, options);
        return count >= 3 ? count : null;
      },
      240_000,
      5_000
    );

    const clearSimulation = await apiRequest(
      outputs.apiBaseUrl,
      `/v1/endpoints/${encodeURIComponent(endpointId)}/simulate`,
      "DELETE",
      token
    );
    assert(clearSimulation.status === 200, `Clear simulation failed: ${clearSimulation.status} ${clearSimulation.text}`);

    invokeWorkerJob(job, options);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    invokeWorkerJob(job, options);

    await waitFor(
      "incident RESOLVED",
      async () => {
        const incidents = await apiRequest<{ items: Array<{ endpointId: string; state: string }> }>(
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

    await waitFor(
      "alert dedupe RESOLVED entries",
      async () => {
        const count = dedupeCount(`${orgId}:${endpointId}:us-east-1:RESOLVED:`, options);
        return count >= 3 ? count : null;
      },
      240_000,
      5_000
    );

    const notifierFailures = notifierFailureCount(startMs, options);
    assert(notifierFailures === 0, `Notifier failure logs detected: ${notifierFailures}`);

    console.log("Integration checks passed:");
    console.log(`- org creation: ${orgId}`);
    console.log(`- endpoint probe cycle + incident open/resolve: ${endpointId}`);
    console.log("- websocket health/incident events");
    console.log("- notifier alert delivery dedupe records (email/slack/webhook)");
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
