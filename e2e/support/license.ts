import crypto from 'node:crypto';

/**
 * Enterprise licenses for tests, signed with a key that only development builds trust (through
 * CT_LICENSE_PUBLIC_KEY; the published image ignores it). Never used for a real license.
 */
export const TEST_LICENSE_PUBLIC_KEY = 'mUbT7G1LsP-nZss6NAJcKbUYIAL3Gvrfpwo8BuQcl80';
const TEST_SIGNING_KEY = crypto.createPrivateKey('-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIHTIdd3ImCm3MxzKCbtX7xpUqE6lVx5uss7czf2xOAWi\n-----END PRIVATE KEY-----');

export function testLicense(over: Record<string, unknown> = {}): string {
  const now = Date.now();
  const payload = { v: 1, kid: 'test', id: 'lic_test', customer: 'Test Co', email: 'buyer@example.com', plan: 'enterprise', seats: 50, requests_per_year: 100_000_000, features: ['*'], issued_at: now, expires_at: now + 365 * 86_400_000, ...over };
  const head = `ctl1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${head}.${crypto.sign(null, Buffer.from(head), TEST_SIGNING_KEY).toString('base64url')}`;
}
