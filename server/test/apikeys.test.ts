import { describe, expect, it } from 'vitest';
import { generateApiKey, looksLikeApiKey, hashApiKey, API_KEY_REGEX } from '../src/crypto/apikeys.js';

describe('api keys', () => {
  it('generates keys in the documented format with a valid checksum', () => {
    for (let i = 0; i < 50; i++) {
      const k = generateApiKey();
      expect(k.plaintext).toMatch(API_KEY_REGEX);
      expect(k.plaintext.length).toBe(45);
      expect(looksLikeApiKey(k.plaintext)).toBe(true);
      expect(k.prefix).toBe(k.plaintext.slice(0, 10));
      expect(k.last4).toBe(k.plaintext.slice(-4));
      expect(k.hash).toBe(hashApiKey(k.plaintext));
    }
  });

  it('rejects a key whose checksum does not match (typo / forgery)', () => {
    const k = generateApiKey().plaintext;
    const mutated = k.slice(0, 8) + (k[8] === 'a' ? 'b' : 'a') + k.slice(9);
    expect(looksLikeApiKey(mutated)).toBe(false);
    expect(looksLikeApiKey('ct_sk_nope')).toBe(false);
    expect(looksLikeApiKey('sk-openai-style')).toBe(false);
  });
});
