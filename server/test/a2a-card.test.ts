import { describe, expect, it } from 'vitest';
import { cardCandidates, jsonRpcEndpoint, METHODS, publishedCard } from '../src/a2a/card.js';

describe('A2A Agent Cards', () => {
  it('looks for the card under a base URL, or takes a card URL as given', () => {
    expect(cardCandidates('https://agent.example.com/')).toEqual(['https://agent.example.com/.well-known/agent-card.json', 'https://agent.example.com/.well-known/agent.json']);
    expect(cardCandidates('https://agent.example.com/cards/research.json')).toEqual(['https://agent.example.com/cards/research.json']);
  });

  it('finds the JSON-RPC endpoint in a 1.0 card, in the agent’s order of preference', () => {
    const card = { supportedInterfaces: [{ url: 'grpc://agent:9000', protocolBinding: 'GRPC' }, { url: '/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] };
    expect(jsonRpcEndpoint(card, 'https://agent.example.com/.well-known/agent-card.json')).toEqual({ url: 'https://agent.example.com/rpc', version: '1.0' });
  });

  it('finds it in a 0.3 card, including additionalInterfaces', () => {
    expect(jsonRpcEndpoint({ url: 'https://a.example.com/a2a', protocolVersion: '0.3.0' }, 'https://a.example.com/')).toEqual({ url: 'https://a.example.com/a2a', version: '0.3.0' });
    expect(jsonRpcEndpoint({ url: 'https://a.example.com/grpc', preferredTransport: 'GRPC', additionalInterfaces: [{ url: 'https://a.example.com/jsonrpc', transport: 'JSONRPC' }] }, 'https://a.example.com/')).toEqual({ url: 'https://a.example.com/jsonrpc', version: '0.3' });
  });

  it('says what an agent offers when it has no JSON-RPC', () => {
    const r = jsonRpcEndpoint({ supportedInterfaces: [{ url: 'https://a/x', protocolBinding: 'HTTP+JSON' }] }, 'https://a/');
    expect(r).toEqual({ error: expect.stringContaining('HTTP+JSON but not JSON-RPC') });
  });

  it('publishes a 1.0 card pointing at Control Tower, asking for its key, unsigned', () => {
    const card = { name: 'R', skills: [{ id: 's' }], supportedInterfaces: [{ url: 'https://agent/rpc', protocolBinding: 'JSONRPC' }], securitySchemes: { theirs: {} }, securityRequirements: [{ schemes: { theirs: { list: [] } } }], signatures: [{}] };
    const out = publishedCard(card, 'https://ct/a2a/r', '1.0');
    expect(out.supportedInterfaces).toEqual([{ url: 'https://ct/a2a/r', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    expect(Object.keys(out.securitySchemes as object)).toEqual(['controltower']);
    expect(out.securityRequirements).toEqual([{ schemes: { controltower: { list: [] } } }]);
    expect(out.signatures).toBeUndefined();
    expect(out.skills).toEqual(card.skills);
    expect(JSON.stringify(out)).not.toContain('https://agent/');
  });

  it('publishes a 0.3 card the 0.3 way', () => {
    const out = publishedCard({ name: 'L', url: 'https://agent/rpc', preferredTransport: 'JSONRPC', security: [{ theirs: [] }] }, 'https://ct/a2a/l', '0.3.0');
    expect(out).toMatchObject({ url: 'https://ct/a2a/l', preferredTransport: 'JSONRPC', security: [{ controltower: [] }], securitySchemes: { controltower: { type: 'http', scheme: 'bearer' } } });
  });

  it('knows every method by both names, and which ones read', () => {
    expect(METHODS['message/send']).toEqual(METHODS.SendMessage);
    expect(METHODS['tasks/get']!.op).toBe('read');
    expect(METHODS.CancelTask!.op).toBe('write');
    expect(METHODS['message/stream']!.stream).toBe(true);
  });
});
