import { describe, expect, it } from 'vitest';
import { getIdentity } from './jwt.js';

describe('getIdentity', () => {
  it('extracts valid string claims', () => {
    const event = {
      requestContext: {
        authorizer: {
          jwt: {
            claims: {
              sub: 'user-123',
              email: 'user@example.com'
            }
          }
        }
      }
    } as never;

    expect(getIdentity(event)).toEqual({
      userId: 'user-123',
      email: 'user@example.com'
    });
  });

  it('throws when claims are missing or wrong type', () => {
    const event = {
      requestContext: {
        authorizer: {
          jwt: {
            claims: {
              sub: 123,
              email: true
            }
          }
        }
      }
    } as never;

    expect(() => getIdentity(event)).toThrow('Missing authenticated identity claims');
  });
});
