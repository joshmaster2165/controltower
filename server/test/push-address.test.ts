import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/a2a/push.js';

describe('push relay: only public addresses', () => {
  it('refuses every way of writing a private IPv4 address in IPv6', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '100.64.0.1', '0.0.0.0',
      '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:0a00:0001',
      '::127.0.0.1', '::7f00:1', '64:ff9b::7f00:1', '64:ff9b::169.254.169.254', '64:ff9b:1::1', '2002:7f00:1::', '2002:a9fe:a9fe::1',
      'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001::1', '2001:db8::1', '100::1', 'fe80::1%eth0', 'not-an-ip:::',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it('lets public addresses through', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
