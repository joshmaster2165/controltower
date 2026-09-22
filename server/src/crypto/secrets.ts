import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Secrets at rest: AES-256-GCM under a single master key.
 * Token format: v1.<key_id>.<nonce_b64url>.<ct_b64url>.<tag_b64url>
 * AAD binds the ciphertext to (table.column.row_id) so it cannot be pasted
 * across rows.
 */

export interface MasterKey {
  id: string;
  key: Buffer;
  source: 'env' | 'file' | 'generated';
  file?: string;
}

export function loadOrCreateMasterKey(dataDir: string, envValue?: string): MasterKey {
  const file = path.join(dataDir, 'master.key');
  const fromEnv = envValue ? decodeKey(envValue, 'CT_MASTER_KEY') : null;
  let fromFile: Buffer | null = null;
  if (fs.existsSync(file)) {
    fromFile = decodeKey(fs.readFileSync(file, 'utf8').trim(), file);
  }

  if (fromEnv && fromFile && !fromEnv.equals(fromFile)) {
    throw new Error(
      `CT_MASTER_KEY differs from ${file}. Refusing to start: this would silently orphan encrypted secrets. Remove one of them.`,
    );
  }

  if (fromEnv) return { id: keyId(fromEnv), key: fromEnv, source: 'env' };
  if (fromFile) return { id: keyId(fromFile), key: fromFile, source: 'file', file };

  fs.mkdirSync(dataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 });
  return { id: keyId(key), key, source: 'generated', file };
}

function decodeKey(s: string, where: string): Buffer {
  const b = Buffer.from(s, 'base64');
  if (b.length !== 32) throw new Error(`${where}: master key must be 32 bytes base64 (got ${b.length})`);
  return b;
}

function keyId(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 8);
}

export class SecretBox {
  constructor(private readonly mk: MasterKey) {}

  get keyId(): string {
    return this.mk.id;
  }

  encrypt(plaintext: string, aad: string): string {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.mk.key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.mk.id, b64(nonce), b64(ct), b64(tag)].join('.');
  }

  decrypt(token: string, aad: string): string {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('secret: bad token format');
    const [, kid, nonceS, ctS, tagS] = parts as [string, string, string, string, string];
    if (kid !== this.mk.id) throw new Error(`secret: encrypted with key ${kid}, current key is ${this.mk.id}`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.mk.key, Buffer.from(nonceS, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctS, 'base64url')), decipher.final()]);
    return pt.toString('utf8');
  }
}

function b64(b: Buffer): string {
  return b.toString('base64url');
}

// ---- Passwords (scrypt; no native deps, fine for a handful of admin accounts) ----

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = await scrypt(password, salt, {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
    keylen: expected.length,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function scrypt(password: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

// ---- Random tokens ----

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
