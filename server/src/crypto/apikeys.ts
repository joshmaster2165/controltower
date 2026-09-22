import crypto from 'node:crypto';
import { sha256Hex } from './secrets.js';

/**
 * API key format: ct_sk_<32 base62><_><6 base62 crc32 of the random part>.
 * The CRC suffix lets secret scanners validate matches with ~zero false
 * positives. At rest we store sha256(full key); the random part has ~190 bits
 * of entropy so no KDF stretching is needed.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const API_KEY_PREFIX = 'ct_sk_';
export const API_KEY_REGEX = /^ct_sk_[0-9A-Za-z]{32}_[0-9A-Za-z]{6}$/;

function base62(bytes: Buffer, len: number): string {
  let out = '';
  // Rejection-free approach: use bigint division for uniformity.
  let n = BigInt('0x' + bytes.toString('hex'));
  const base = 62n;
  while (out.length < len) {
    out = ALPHABET[Number(n % base)] + out;
    n /= base;
  }
  return out;
}

function crc32(s: string): number {
  let c = ~0;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i);
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function crcSuffix(random: string): string {
  const n = crc32(random);
  let out = '';
  let v = n;
  for (let i = 0; i < 6; i++) {
    out = ALPHABET[v % 62] + out;
    v = Math.floor(v / 62);
  }
  return out;
}

export interface GeneratedKey {
  plaintext: string;
  hash: string;
  prefix: string;
  last4: string;
}

export function generateApiKey(): GeneratedKey {
  const random = base62(crypto.randomBytes(24), 32);
  const plaintext = `${API_KEY_PREFIX}${random}_${crcSuffix(random)}`;
  return {
    plaintext,
    hash: sha256Hex(plaintext),
    prefix: plaintext.slice(0, 10),
    last4: plaintext.slice(-4),
  };
}

/** Cheap structural check before hashing; rejects obvious garbage early. */
export function looksLikeApiKey(s: string): boolean {
  if (!API_KEY_REGEX.test(s)) return false;
  const random = s.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + 32);
  return crcSuffix(random) === s.slice(-6);
}

export function hashApiKey(s: string): string {
  return sha256Hex(s);
}
