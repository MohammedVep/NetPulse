import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursor helpers', () => {
  it('encodes and decodes opaque cursors', () => {
    const input = { orgId: 'org_1', endpointId: 'org_1__ep_1', ts: '2026-03-01T00:00:00.000Z' };
    const encoded = encodeCursor(input);
    const decoded = decodeCursor<typeof input>(encoded);

    expect(decoded).toEqual(input);
  });

  it('returns undefined for missing cursor', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });
});
