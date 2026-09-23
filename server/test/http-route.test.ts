import { describe, expect, it } from 'vitest';
import { ctKey, httpOperation, routeLabel, routeOperation, upstreamHeaders, upstreamUrl } from '../src/http/route.js';

describe('http gateway routing', () => {
  it('joins paths onto the base URL and keeps the query', () => {
    expect(upstreamUrl('https://api.example.com/v2', '/users/7', '?q=1')?.toString()).toBe('https://api.example.com/v2/users/7?q=1');
    expect(upstreamUrl('https://api.example.com/v2/', '/', '')?.toString()).toBe('https://api.example.com/v2/');
    expect(upstreamUrl('https://api.example.com', '/a/b', '')?.toString()).toBe('https://api.example.com/a/b');
  });

  it('refuses anything that climbs out of the registered base', () => {
    expect(upstreamUrl('https://api.example.com/v2', '/../admin', '')).toBeNull();
    expect(upstreamUrl('https://api.example.com/v2', '/users/../../admin', '')).toBeNull();
    expect(upstreamUrl('https://api.example.com/v2', '/%2e%2e/admin', '')).toBeNull();
    expect(upstreamUrl('https://api.example.com/v2', '/%2E%2E%2Fadmin', '')).toBeNull();
    expect(upstreamUrl('https://api.example.com/v2', '/..\\admin', '')).toBeNull();
    expect(upstreamUrl('https://api.example.com/v2', '/./users', '')).toBeNull();
    // A protocol-relative path stays on the registered host; an absolute URL is refused outright.
    expect(upstreamUrl('https://api.example.com/v2', '//evil.example/x', '')?.origin).toBe('https://api.example.com');
    expect(upstreamUrl('https://api.example.com/v2', '/https://evil.example/x', '')).toBeNull();
  });

  it('folds identifiers so the map shows routes, not records', () => {
    expect(routeLabel('get', '/v2/users/8812/orders')).toBe('GET /v2/users/:id/orders');
    expect(routeLabel('DELETE', '/contacts/c_8812')).toBe('DELETE /contacts/:id');
    expect(routeLabel('GET', '/items/3f2b9c1e-7a4d-4e2b-9a1c-5d6e7f8a9b0c')).toBe('GET /items/:id');
    expect(routeLabel('GET', '/customers/cus_9a8B7c6D')).toBe('GET /customers/:id');
    expect(routeLabel('GET', '/api/v1/components')).toBe('GET /api/v1/components');
    expect(routeLabel('GET', '/')).toBe('GET /');
  });

  it('classifies methods as read, write or destructive', () => {
    expect(httpOperation('GET')).toBe('read');
    expect(httpOperation('head')).toBe('read');
    expect(httpOperation('POST')).toBe('write');
    expect(httpOperation('PATCH')).toBe('write');
    expect(httpOperation('DELETE')).toBe('admin');
    expect(routeOperation('DELETE /v2/users/:id')).toBe('admin');
    expect(routeOperation(null)).toBe('unknown');
  });

  it('finds the Control Tower key without mistaking the API’s own credentials for it', () => {
    expect(ctKey({ 'x-ct-key': 'ct_sk_abc' })).toEqual({ key: 'ct_sk_abc', source: 'x-ct-key' });
    expect(ctKey({ authorization: 'Bearer ct_sk_abc' })).toEqual({ key: 'ct_sk_abc', source: 'authorization' });
    expect(ctKey({ 'x-api-key': 'ct_sk_abc' })).toEqual({ key: 'ct_sk_abc', source: 'x-api-key' });
    expect(ctKey({ authorization: 'Bearer sk-live-upstream' })).toBeUndefined();
  });

  it('never forwards the Control Tower key or x-ct-* headers, and injects stored credentials', () => {
    const h = upstreamHeaders(
      { authorization: 'Bearer ct_sk_abc', 'x-ct-approval': 'ct_grn_1', 'content-type': 'application/json', connection: 'keep-alive', host: 'tower', 'accept-encoding': 'gzip' },
      'authorization',
      { type: 'header', header: 'X-Api-Key', token: 'upstream-secret' },
    );
    expect(h.authorization).toBeUndefined();
    expect(h['x-ct-approval']).toBeUndefined();
    expect(h.connection).toBeUndefined();
    expect(h.host).toBeUndefined();
    expect(h['accept-encoding']).toBe('identity');
    expect(h['content-type']).toBe('application/json');
    expect(h['x-api-key']).toBe('upstream-secret');
    // With x-ct-key, the agent's own Authorization passes through unless the API has stored credentials.
    expect(upstreamHeaders({ 'x-ct-key': 'ct_sk_abc', authorization: 'Bearer agent-token' }, 'x-ct-key', { type: 'none' }).authorization).toBe('Bearer agent-token');
    expect(upstreamHeaders({ 'x-ct-key': 'ct_sk_abc', authorization: 'Bearer agent-token' }, 'x-ct-key', { type: 'bearer', token: 'stored' }).authorization).toBe('Bearer stored');
  });
});
