import { App } from "aws-cdk-lib";
import { NetPulseStack } from "../lib/netpulse-stack.js";

const app = new App();

const environments = ["dev", "staging", "prod"] as const;

for (const environment of environments) {
  new NetPulseStack(app, `NetPulse-${environment}`, {
    envName: environment
  });
}
