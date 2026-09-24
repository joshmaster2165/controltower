import { describe, expect, it } from 'vitest';
import { extractApiKey, keyProblem } from '../src/gateway/key.js';
import type { KeyRecord } from '../src/registry.js';

const req = (headers: Record<string, string>) => ({ headers });

describe('presented keys', () => {
  it('reads the key from every header SDKs send it in', () => {
    expect(extractApiKey(req({ authorization: 'Bearer ct_sk_a' }))).toBe('ct_sk_a');
    expect(extractApiKey(req({ authorization: 'sk-1234567890abcdef' }))).toBe('sk-1234567890abcdef');
    expect(extractApiKey(req({ 'x-api-key': 'ct_sk_b' }))).toBe('ct_sk_b');
    expect(extractApiKey(req({ 'x-litellm-api-key': 'Bearer ct_sk_c' }))).toBe('ct_sk_c');
    expect(extractApiKey(req({ 'api-key': 'ct_sk_d' }))).toBe('ct_sk_d');
  });
  it('prefers Authorization and ignores Basic credentials and empty values', () => {
    expect(extractApiKey(req({ authorization: 'Bearer first', 'x-api-key': 'second' }))).toBe('first');
    expect(extractApiKey(req({ authorization: 'Basic dXNlcjpwYXNz', 'x-api-key': 'k' }))).toBe('k');
    expect(extractApiKey(req({ authorization: 'Bearer ' }))).toBeUndefined();
    expect(extractApiKey(req({}))).toBeUndefined();
  });
  it('refuses blocked and expired keys', () => {
    const k = { enabled: true, expiresAt: undefined } as KeyRecord;
    expect(keyProblem(k)).toBeUndefined();
    expect(keyProblem({ ...k, enabled: false })).toBe('disabled');
    expect(keyProblem({ ...k, expiresAt: Date.now() - 1 })).toBe('expired');
    expect(keyProblem({ ...k, expiresAt: Date.now() + 60_000 })).toBeUndefined();
  });
});
