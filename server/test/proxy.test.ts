import { describe, expect, it } from 'vitest';
import { describeProxy, outboundProxyFromEnv } from '../src/net/proxy.js';

describe('outbound proxy', () => {
  it('reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY in either case and never proxies the server itself', () => {
    expect(outboundProxyFromEnv({}, 4000)).toBeUndefined();
    expect(outboundProxyFromEnv({ https_proxy: 'http://proxy:3128', no_proxy: '.internal' }, 4000)).toEqual({ httpProxy: undefined, httpsProxy: 'http://proxy:3128', noProxy: '.internal,127.0.0.1:4000,localhost:4000' });
    expect(outboundProxyFromEnv({ HTTP_PROXY: 'http://proxy:3128' }, 8080)).toEqual({ httpProxy: 'http://proxy:3128', httpsProxy: 'http://proxy:3128', noProxy: '127.0.0.1:8080,localhost:8080' });
  });
  it('never logs credentials', () => {
    expect(describeProxy({ httpProxy: 'http://user:secret@proxy:3128', httpsProxy: 'http://user:secret@proxy:3128', noProxy: '' })).toBe('http://proxy:3128');
  });
});
