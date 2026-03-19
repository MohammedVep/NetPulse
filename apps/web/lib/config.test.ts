import { describe, expect, it } from 'vitest';
import { config } from './config';

describe('web config', () => {
  it('has API and websocket URLs', () => {
    expect(typeof config.apiBaseUrl).toBe('string');
    expect(typeof config.wsUrl).toBe('string');
    expect(config.apiBaseUrl.length).toBeGreaterThan(0);
    expect(config.wsUrl.length).toBeGreaterThan(0);
  });

  it('exposes Cognito public config fields', () => {
    expect(typeof config.cognitoUserPoolId).toBe('string');
    expect(typeof config.cognitoUserPoolClientId).toBe('string');
    expect(typeof config.awsLoadBalancerUrl).toBe('string');
    expect(typeof config.gcpLoadBalancerUrl).toBe('string');
    expect(typeof config.gcpWebUrl).toBe('string');
  });

  it('exposes a demo org id', () => {
    expect(typeof config.demoOrgId).toBe('string');
    expect(config.demoOrgId.length).toBeGreaterThan(0);
  });

  it('exposes recruiter testing preset fields', () => {
    expect(typeof config.defaultWorkspaceName).toBe('string');
    expect(typeof config.defaultEndpointName).toBe('string');
    expect(typeof config.defaultEndpointUrl).toBe('string');
    expect(typeof config.testAlertEmail).toBe('string');
    expect(typeof config.testSlackWebhookUrl).toBe('string');
    expect(typeof config.testWebhookUrl).toBe('string');
    expect(typeof config.showTestingHints).toBe('boolean');
  });

  it("exposes proof-pack routing config", () => {
    expect(typeof config.proofPackUrl).toBe("string");
    expect(config.proofPackUrl.length).toBeGreaterThan(0);
  });
});
