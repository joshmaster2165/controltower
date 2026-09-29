import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GRACE_MS, WARN_MS, parseLicense, signLicense, stateOf, type LicensePayload } from '../src/ee/license.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const keys = { t: publicKey.export({ format: 'jwk' }).x! };
const now = Date.UTC(2026, 9, 1);
const base: LicensePayload = { v: 1, kid: 't', id: 'lic_1', customer: 'Acme', email: 'a@acme.com', plan: 'enterprise', seats: 10, requests_per_year: 100_000_000, features: ['*'], issued_at: now, expires_at: now + 365 * 86_400_000 };

describe('license keys', () => {
  it('verify offline against the public key, and refuse any change to what was signed', () => {
    const key = signLicense(base, privateKey);
    expect(parseLicense(key, keys)).toMatchObject({ ok: true, license: { customer: 'Acme', seats: 10 } });

    const [h, , sig] = key.split('.');
    const more = Buffer.from(JSON.stringify({ ...base, seats: 10_000 })).toString('base64url');
    expect(parseLicense(`${h}.${more}.${sig}`, keys)).toMatchObject({ ok: false, reason: expect.stringContaining('signature') });

    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    expect(parseLicense(signLicense(base, other), keys)).toMatchObject({ ok: false, reason: expect.stringContaining('signature') });
    expect(parseLicense(signLicense({ ...base, kid: 'unknown' }, privateKey), keys)).toMatchObject({ ok: false, reason: expect.stringContaining('Upgrade') });
    expect(parseLicense('sk-not-a-license', keys)).toMatchObject({ ok: false, reason: expect.stringContaining('ctl1.') });
    expect(parseLicense('ctl1.@@@.x', keys).ok).toBe(false);
  });

  it('move from valid to expiring, grace and expired with the clock', () => {
    process.env.CT_LICENSE_PUBLIC_KEY = keys.t;
    const key = signLicense({ ...base, kid: 'test' }, privateKey);
    const end = base.expires_at;
    expect(stateOf(key, 'env', end - WARN_MS - 1).status).toBe('valid');
    expect(stateOf(key, 'env', end - WARN_MS + 1).status).toBe('expiring');
    expect(stateOf(key, 'env', end + 1).status).toBe('grace');
    expect(stateOf(key, 'env', end + GRACE_MS + 1).status).toBe('expired');
    expect(stateOf(undefined, undefined).status).toBe('none');
    delete process.env.CT_LICENSE_PUBLIC_KEY;
  });

  it('the published build trusts only the licensor key', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.CT_LICENSE_PUBLIC_KEY = keys.t;
    expect(stateOf(signLicense({ ...base, kid: 'test' }, privateKey), 'env').status).toBe('invalid');
    process.env.NODE_ENV = prev;
    delete process.env.CT_LICENSE_PUBLIC_KEY;
  });
});
