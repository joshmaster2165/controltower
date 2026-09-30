import crypto, { type KeyObject } from 'node:crypto';

/**
 * JWTs for tests, signed with node:crypto (independent of the library Control Tower verifies them with):
 * an identity provider's signing key, its public JWK, and tokens with any claims.
 */
export interface TestSigner {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function testSigner(kid = 'test-1'): TestSigner {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'ES256', use: 'sig' } };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** An ES256 token. `exp` and `iat` are seconds; exp defaults to ten minutes from now. */
export function signJwt(s: TestSigner, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'ES256', typ: 'JWT', kid: s.kid })}.${b64({ iat: now, exp: now + 600, ...claims })}`;
  const sig = crypto.sign('sha256', Buffer.from(head), { key: s.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${sig.toString('base64url')}`;
}
