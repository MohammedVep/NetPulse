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
  });

  it('exposes a demo org id', () => {
    expect(typeof config.demoOrgId).toBe('string');
    expect(config.demoOrgId.length).toBeGreaterThan(0);
  });
});
