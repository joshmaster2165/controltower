import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretBox, loadOrCreateMasterKey, hashPassword, verifyPassword } from '../src/crypto/secrets.js';

describe('secrets', () => {
  it('round-trips and binds ciphertext to its AAD', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    const mk = loadOrCreateMasterKey(dir);
    expect(mk.source).toBe('generated');
    const box = new SecretBox(mk);
    const token = box.encrypt('{"api_key":"sk-secret"}', 'providers.creds_enc.row1');
    expect(token.startsWith('v1.')).toBe(true);
    expect(box.decrypt(token, 'providers.creds_enc.row1')).toBe('{"api_key":"sk-secret"}');
    expect(() => box.decrypt(token, 'providers.creds_enc.row2')).toThrow();
    // Second load reads the file back and yields the same key id.
    expect(loadOrCreateMasterKey(dir).id).toBe(mk.id);
  });

  it('refuses to start when env and file keys disagree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    loadOrCreateMasterKey(dir);
    const other = Buffer.alloc(32, 7).toString('base64');
    expect(() => loadOrCreateMasterKey(dir, other)).toThrow(/Refusing to start/);
  });

  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct-horse-battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});
