import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';

/**
 * Outbound proxy for Control Tower's own calls — to model providers, MCP
 * servers, HTTP APIs, alert channels and token endpoints — for networks
 * where the server only reaches the internet through a corporate proxy.
 * Reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY (either case). The server's own
 * loopback address is never proxied, so the demo fleet keeps working.
 */
export interface OutboundProxy {
  httpProxy: string | undefined;
  httpsProxy: string | undefined;
  noProxy: string;
}

let proxy: OutboundProxy | undefined;

export function outboundProxyFromEnv(env: NodeJS.ProcessEnv, selfPort: number): OutboundProxy | undefined {
  const httpProxy = env.HTTP_PROXY || env.http_proxy || undefined;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || httpProxy;
  if (!httpProxy && !httpsProxy) return undefined;
  const noProxy = [env.NO_PROXY || env.no_proxy, `127.0.0.1:${selfPort}`, `localhost:${selfPort}`].filter(Boolean).join(',');
  return { httpProxy, httpsProxy, noProxy };
}

/** Use the proxy for undici requests and Node's fetch from now on. */
export function useOutboundProxy(p: OutboundProxy | undefined): void {
  proxy = p;
  if (p) setGlobalDispatcher(newAgent({}));
}

/** A connection pool that honours the outbound proxy when one is configured. */
export function newAgent(opts: Agent.Options): Dispatcher {
  if (!proxy) return new Agent(opts);
  return new EnvHttpProxyAgent({
    ...opts,
    ...(proxy.httpProxy ? { httpProxy: proxy.httpProxy } : {}),
    ...(proxy.httpsProxy ? { httpsProxy: proxy.httpsProxy } : {}),
    noProxy: proxy.noProxy,
  });
}

/** For logs: the proxy URL without credentials. */
export function describeProxy(p: OutboundProxy): string {
  const clean = (u: string | undefined) => {
    if (!u) return undefined;
    try {
      const x = new URL(u);
      x.username = '';
      x.password = '';
      return x.toString().replace(/\/$/, '');
    } catch {
      return 'an invalid URL';
    }
  };
  const h = clean(p.httpProxy);
  const s = clean(p.httpsProxy);
  return h === s || !h ? `${s}` : `${s} (https), ${h} (http)`;
}
