import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
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

  it('a trial ends on its end date: no grace period, since nothing renews it', () => {
    process.env.CT_LICENSE_PUBLIC_KEY = keys.t;
    const trial = signLicense({ ...base, kid: 'test', plan: 'trial' }, privateKey);
    expect(stateOf(trial, 'env', base.expires_at - 1).status).toBe('expiring');
    expect(stateOf(trial, 'env', base.expires_at + 1).status).toBe('expired');
    delete process.env.CT_LICENSE_PUBLIC_KEY;
  });

  it('a release build trusts only the licensor key, whatever the environment says; a test build also trusts the test key', async () => {
    const forged = signLicense({ ...base, kid: 'test' }, privateKey);
    const bundle = async (testKeys: boolean) => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-license-build-')), 'license.mjs');
      await build({ entryPoints: [path.resolve(__dirname, '../src/ee/license.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', define: { __CT_TEST_LICENSE_KEYS__: String(testKeys) } });
      return (await import(out)) as typeof import('../src/ee/license.js');
    };
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    process.env.CT_LICENSE_PUBLIC_KEY = keys.t;
    try {
      expect((await bundle(false)).stateOf(forged, 'env').status).toBe('invalid');
      expect((await bundle(true)).stateOf(forged, 'env').status).toBe('valid');
    } finally {
      process.env.NODE_ENV = prev;
      delete process.env.CT_LICENSE_PUBLIC_KEY;
    }
  });
});

describe('license renewal', () => {
  it('takes a renewed key for the same license from the license service, and nothing else', async () => {
    const { openSqlite } = await import('../src/db/index.js');
    const { Licensing } = await import('../src/ee/license.js');
    const http = await import('node:http');
    process.env.CT_LICENSE_PUBLIC_KEY = keys.t;
    const lic = { ...base, kid: 'test', sub: 'sub_1', issued_at: Date.now(), expires_at: Date.now() + 20 * 86_400_000 };
    let answer: unknown = { status: 'unchanged' };
    const svc = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        expect(JSON.parse(b).key).toBeTruthy();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((r) => svc.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(svc.address() as { port: number }).port}`;
    const log = { info: () => undefined, warn: () => undefined };
    try {
      const db = openSqlite('', { memory: true });
      const l = new Licensing(db.write, signLicense(lic, privateKey));
      await l.load();
      expect(await l.refresh(url, log)).toBe('unchanged');
      answer = { status: 'renewed', key: signLicense({ ...lic, id: 'someone-else', expires_at: lic.expires_at + 365 * 86_400_000 }, privateKey) };
      expect(await l.refresh(url, log)).toBe('failed');
      answer = { status: 'renewed', key: signLicense({ ...lic, seats: 40, expires_at: lic.expires_at + 365 * 86_400_000 }, privateKey) };
      expect(await l.refresh(url, log)).toBe('renewed');
      expect(l.current.license).toMatchObject({ seats: 40 });
      expect(l.current.status).toBe('valid');
      // Restarted: the renewal is remembered over the older CT_LICENSE_KEY.
      const again = new Licensing(db.write, signLicense(lic, privateKey));
      expect((await again.load()).license?.seats).toBe(40);
      answer = { status: 'ended' };
      expect(await l.refresh(url, log)).toBe('ended');
      expect(await new Licensing(db.write, signLicense((({ sub: _s, ...rest }) => rest)(lic), privateKey)).refresh(url, log)).toBe('skipped');
    } finally {
      svc.close();
      delete process.env.CT_LICENSE_PUBLIC_KEY;
    }
  });
});
