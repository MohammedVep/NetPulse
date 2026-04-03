import type { ScheduledEvent } from "aws-lambda";
import {
  ECSClient,
  UpdateServiceCommand,
  waitUntilServicesStable
} from "@aws-sdk/client-ecs";
import {
  DisableRuleCommand,
  EnableRuleCommand,
  EventBridgeClient
} from "@aws-sdk/client-eventbridge";

const ecs = new ECSClient({});
const eventBridge = new EventBridgeClient({});

interface ControlledService {
  serviceName: string;
  desiredCount: number;
}

interface ScaleControllerEvent extends ScheduledEvent {
  action?: "start" | "stop";
}

const cluster = process.env.CONTROLLED_CLUSTER ?? "";
const controlledServices = JSON.parse(process.env.CONTROLLED_SERVICES ?? "[]") as ControlledService[];
const probeRuleName = process.env.CONTROLLED_PROBE_RULE_NAME ?? "";

function resolveAction(event: ScaleControllerEvent): "start" | "stop" {
  if (event.action === "start" || event.action === "stop") {
    return event.action;
  }

  throw new Error("Scale controller action must be 'start' or 'stop'");
}

async function setProbeScheduleEnabled(enabled: boolean): Promise<void> {
  if (!probeRuleName) {
    return;
  }

  await eventBridge.send(
    enabled
      ? new EnableRuleCommand({ Name: probeRuleName })
      : new DisableRuleCommand({ Name: probeRuleName })
  );
}

async function updateServiceDesiredCounts(desiredCountFor: (service: ControlledService) => number): Promise<void> {
  await Promise.all(
    controlledServices.map((service) =>
      ecs.send(
        new UpdateServiceCommand({
          cluster,
          service: service.serviceName,
          desiredCount: desiredCountFor(service)
        })
      )
    )
  );
}

async function waitForServicesSteadyState(): Promise<void> {
  if (!cluster || controlledServices.length === 0) {
    return;
  }

  await waitUntilServicesStable(
    {
      client: ecs,
      minDelay: 5,
      maxDelay: 30,
      maxWaitTime: 600
    },
    {
      cluster,
      services: controlledServices.map((service) => service.serviceName)
    }
  );
}

export async function handler(event: ScaleControllerEvent) {
  const action = resolveAction(event);
  if (!cluster || controlledServices.length === 0) {
    throw new Error("Scale controller is missing cluster or service configuration");
  }

  if (action === "stop") {
    await setProbeScheduleEnabled(false);
    await updateServiceDesiredCounts(() => 0);
  } else {
    await updateServiceDesiredCounts((service) => service.desiredCount);
    await waitForServicesSteadyState();
    await setProbeScheduleEnabled(true);
  }

  const summary = {
    action,
    cluster,
    probeRuleName,
    services: controlledServices,
    timestamp: new Date().toISOString()
  };

  console.log(JSON.stringify({ event: "scale_controller_completed", ...summary }));
  return summary;
}
