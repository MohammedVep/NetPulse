import { describe, expect, it } from 'vitest';
import { getOrgIdFromEndpointId, makeEndpointId } from './ids.js';

describe('id helpers', () => {
  it('extracts org id from endpoint id', () => {
    const endpointId = makeEndpointId('org_abc');
    expect(getOrgIdFromEndpointId(endpointId)).toBe('org_abc');
  });

  it('throws on malformed endpoint id', () => {
    expect(() => getOrgIdFromEndpointId('bad-id')).toThrow('Invalid endpointId format');
  });
});
