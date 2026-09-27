import { describe, expect, it } from 'vitest';
import { checkWebhook, isPrivateAddress, pushConfigs } from '../src/a2a/push.js';

describe('relayed A2A push notifications', () => {
  it('knows private, loopback, link-local and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses webhooks on private addresses unless allowed, and anything but http(s)', async () => {
    expect(await checkWebhook('http://169.254.169.254/latest/meta-data', false)).toMatch(/private address/);
    expect(await checkWebhook('http://127.0.0.1:9000/hook', false)).toMatch(/private address/);
    expect(await checkWebhook('http://localhost:9000/hook', false)).toMatch(/private addresses/);
    expect(await checkWebhook('http://127.0.0.1:9000/hook', true)).toBeUndefined();
    expect(await checkWebhook('file:///etc/passwd', true)).toMatch(/http or https/);
    expect(await checkWebhook('not a url', true)).toMatch(/not a valid URL/);
  });

  it('finds the push configuration in the setup call and inside a message, in both versions', () => {
    expect(pushConfigs({ taskId: 't', url: 'https://a/1', token: 'x' })).toHaveLength(1); // 1.0 setup call
    expect(pushConfigs({ taskId: 't', pushNotificationConfig: { url: 'https://a/2' } })).toHaveLength(1); // 0.3 set
    expect(pushConfigs({ message: {}, configuration: { taskPushNotificationConfig: { url: 'https://a/3' } } })).toHaveLength(1);
    expect(pushConfigs({ message: {}, configuration: { pushNotificationConfig: { url: 'https://a/4' } } })).toHaveLength(1);
    expect(pushConfigs({ message: {}, configuration: {} })).toHaveLength(0);
  });
});
