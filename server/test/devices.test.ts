import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { DeviceAuth, newUserCode, normaliseUserCode, ACCESS_TTL_S } from '../src/ee/devices.js';
import { idpProblem, rolloutFiles, rolloutUrlProblem } from '../src/ee/laptops/templates.js';
import type { KeyRecord } from '../src/registry.js';

const key = (over: Partial<KeyRecord> = {}): KeyRecord =>
  ({ id: 'k1', name: 'claude-code', hash: '', prefix: '', last4: '', agentId: 'claude-code', team: undefined, project: undefined, tags: [], allowedModels: [], allowedMcp: [], limits: {}, enabled: true, expiresAt: undefined, demo: false, createdAt: 0, lastUsedAt: undefined, delegatedOnly: false, regions: [], tokensOnly: false, prevHash: undefined, prevExpiresAt: undefined, rotation: {} as KeyRecord['rotation'], ...over }) as KeyRecord;

async function setup(opts: { licensed?: () => boolean; keys?: Map<string, KeyRecord> } = {}) {
  const db = openSqlite('', { memory: true });
  const keys = opts.keys ?? new Map([['k1', key()]]);
  const d = new DeviceAuth({ db: db.write, key: crypto.randomBytes(32), keys: () => keys, allowed: opts.licensed ?? (() => true) });
  await d.reload();
  return { d, db, keys };
}

describe('laptop sign-in tokens', () => {
  it('are accepted until they expire, and refused when changed, signed with another key, or unlicensed', async () => {
    let licensed = true;
    const { d } = await setup({ licensed: () => licensed });
    const now = Date.now();
    const t = d.mint({ sessionId: 's1', keyId: 'k1', principal: 'dana@acme.com', client: 'claude-code' }, now);
    expect(t.exp).toBe(now + ACCESS_TTL_S * 1000);
    expect(d.verify(t.token, now + 1000)).toMatchObject({ sessionId: 's1', keyId: 'k1', principal: 'dana@acme.com', client: 'claude-code' });
    expect(d.keyFor(t.token)?.name).toBe('claude-code');
    expect(d.verify(t.token, t.exp + 1)).toBeUndefined();
    // Another key: someone else's server, or a forged token.
    const other = await setup();
    expect(other.d.verify(t.token, now)).toBeUndefined();
    // Edited: the key it names changed.
    const [payload, sig] = t.token.slice('ct_dt_'.length).split('.');
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), k: 'k2' })).toString('base64url');
    expect(d.verify(`ct_dt_${edited}.${sig}`, now)).toBeUndefined();
    expect(d.verify('ct_dt_garbage', now)).toBeUndefined();
    expect(d.verify(`${t.token}x`, now)).toBeUndefined();
    licensed = false;
    expect(d.verify(t.token, now)).toBeUndefined();
  });

  it('give no key when the key behind them is disabled, expired or gone', async () => {
    const keys = new Map([['k1', key()]]);
    const { d } = await setup({ keys });
    const t = d.mint({ sessionId: 's1', keyId: 'k1', principal: 'p', client: 'codex' });
    expect(d.keyFor(t.token)).toBeDefined();
    keys.set('k1', key({ enabled: false }));
    expect(d.keyFor(t.token)).toBeUndefined();
    keys.set('k1', key({ expiresAt: Date.now() - 1 }));
    expect(d.keyFor(t.token)).toBeUndefined();
    keys.delete('k1');
    expect(d.keyFor(t.token)).toBeUndefined();
  });

  it('user codes: consonants, eight of them, typed any way', () => {
    for (let i = 0; i < 200; i++) expect(newUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(normaliseUserCode('bcdf ghjk')).toBe('BCDF-GHJK');
    expect(normaliseUserCode('BCDF-GHJ')).toBe('');
  });

  it('a code expires, can be decided once, and gives its tokens once', async () => {
    const { d, db } = await setup();
    const now = Date.now();
    await db.write.insertInto('admins').values({ id: 'a1', email: 'dana@acme.com', password_hash: 'x', created_at: now, role: 'member', must_change_password: 0 } as never).execute();
    await d.reload();
    await db.write.insertInto('device_rules').values({ id: 'r1', position: 0, client: '*', team_id: null, key_id: 'k1', created_at: now }).execute();
    await d.reload();
    const s = await d.begin({ client: 'codex', deviceName: 'mac', ip: '10.0.0.1' }, now);
    expect(await d.pending(s.userCode, now + 11 * 60_000)).toBeUndefined();
    expect(await d.decide(s.userCode, 'a1', true, now + 11 * 60_000)).toBe(false);
    expect(await d.decide(s.userCode, 'a1', true, now)).toBe(true);
    expect(await d.decide(s.userCode, 'a1', false, now)).toBe(false);
    const got = await d.poll(s.deviceCode, '10.0.0.1', now);
    expect(got).toMatchObject({ ok: true, person: 'dana@acme.com', key_name: 'claude-code' });
    expect(await d.poll(s.deviceCode, '10.0.0.1', now)).toMatchObject({ ok: false, error: 'invalid_grant' });
  });
});

describe('rollout files', () => {
  it('quote Windows paths for cmd, carry no secret, and refuse an address with anything but an origin and path', () => {
    const files = Object.fromEntries(rolloutFiles({ url: 'https://ai.acme.com', clients: ['claude-code', 'claude-desktop', 'codex'], mcp: true, lockdown: true }).map((f) => [f.name, f.content]));
    expect(files['install-controltower-windows.ps1']).toContain('\\"C:\\\\Program Files\\\\ControlTower\\\\ct-auth.cmd\\" token --client claude-code');
    // The .reg file escapes the JSON once more: it reads back as the same JSON.
    const settings = /"Settings"="(.*)"\r\n/.exec(files['controltower-windows.reg']!)![1]!.replace(/\\(.)/g, '$1');
    expect(JSON.parse(settings).apiKeyHelper).toBe('"C:\\Program Files\\ControlTower\\ct-auth.cmd" token --client claude-code');
    expect(files['install-controltower-windows.ps1']).toContain('[IO.File]::WriteAllText');
    // Claude Desktop on Windows runs inferenceCredentialHelper itself: the Windows path, in Windows policy.
    expect(files['controltower-windows.reg']).toContain('"inferenceCredentialHelper"="C:\\\\Program Files\\\\ControlTower\\\\ct-auth.cmd"');
    expect(files['controltower.mobileconfig']).toMatch(/<key>inferenceCredentialHelper<\/key>\s*<string>\/usr\/local\/bin\/ct-auth<\/string>/);
    expect(files['install-controltower-windows.ps1']).not.toContain('-Encoding UTF8');
    expect(files['controltower.mobileconfig']).toContain('<string>com.openai.codex</string>');
    expect(Buffer.from(/<key>requirements_toml_base64<\/key>\s*<string>([^<]+)</.exec(files['controltower.mobileconfig']!)![1]!, 'base64').toString()).toContain('model_provider = "controltower"');
    for (const [name, content] of Object.entries(files)) expect(content, name).not.toMatch(/ct_sk_[A-Za-z0-9]|ct_rt_[A-Za-z0-9]|ct_dt_[A-Za-z0-9]/);
    // Without lockdown or MCP, only the provider settings.
    const plain = Object.fromEntries(rolloutFiles({ url: 'https://ai.acme.com', clients: ['claude-code'], mcp: false, lockdown: false }).map((f) => [f.name, f.content]));
    expect(JSON.parse(plain['claude-code/managed-settings.json']!)).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://ai.acme.com' }, apiKeyHelper: '/usr/local/bin/ct-auth token --client claude-code' });
    expect(plain['claude-code/managed-mcp.json']).toBeUndefined();
    for (const bad of ['ftp://x.com', 'https://x.com/?a=1', 'https://u:p@x.com', 'https://x.com/a b', "https://x.com/'$(id)'", 'not a url']) expect(rolloutUrlProblem(bad), bad).toBeDefined();
    expect(rolloutUrlProblem('https://ai.acme.com/gateway')).toBeUndefined();
  });

  it('with an identity provider: the config file says where people sign in, and only safe values go in it', () => {
    const files = Object.fromEntries(rolloutFiles({ url: 'https://ai.acme.com', clients: ['claude-code'], mcp: false, lockdown: false, idp: { issuer: 'https://acme.okta.com/oauth2/default', clientId: '0oa1b2c3', scope: 'openid email groups offline_access' } }).map((f) => [f.name, f.content]));
    expect(files['install-ct-auth-macos.sh']).toContain('url=https://ai.acme.com\nidp_issuer=https://acme.okta.com/oauth2/default\nidp_client_id=0oa1b2c3\nidp_scope=openid email groups offline_access\n');
    expect(files['install-controltower-windows.ps1']).toContain('idp_client_id=0oa1b2c3');
    expect(idpProblem({ issuer: 'https://login.microsoftonline.com/tenant/v2.0', clientId: '4f1c-11aa' })).toBeUndefined();
    expect(idpProblem({ issuer: 'http://idp.example.com', clientId: 'x' })).toContain('https');
    expect(idpProblem({ issuer: 'https://idp.example.com', clientId: 'a b' })).toBeDefined();
    expect(idpProblem({ issuer: 'https://idp.example.com', clientId: 'x', scope: 'openid; rm -rf' })).toBeDefined();
  });
});
