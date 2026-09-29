import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { supportBundle } from '../src/support/bundle.js';

describe('support bundle', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reports settings by name, health and error counts, and never secrets, hosts or names', async () => {
    Object.assign(process.env, { CT_ADMIN_KEY: 'admin-key-that-must-not-leak', CT_LOG_LEVEL: 'warn', CT_DATABASE_URL_UNUSED: 'postgres://u:pw@db.internal/x', HTTPS_PROXY: 'http://proxyuser:proxypass@proxy.corp:3128' });
    const db = openSqlite('', { memory: true });
    const now = Date.now();
    db.raw
      .prepare("INSERT INTO providers (id, kind, name, slug, base_url, extra, health, health_detail, demo, created_at, updated_at) VALUES ('p1', 'openai-compatible', 'Acme internal LLM', 'acme', 'https://llm.acme.internal/v1', '{\"catalog_id\":\"custom\"}', 'down', ?, 0, ?, ?)")
      .run('401 from https://svc:hunter2@llm.acme.internal/v1/models?api_key=abc123 with Bearer sk-live-abcdefghijklmnop', now, now);
    db.raw.prepare("INSERT INTO flights (id, ts, key_id, key_name, kind, dialect, model_requested, status, http_status, error_code, error_message) VALUES ('f1', ?, 'k1', 'payroll-agent', 'chat', 'openai-chat', 'gpt-x', 'error', 502, 'provider_auth_error', 'secret message')").run(now);

    const b = await supportBundle(db, loadConfig(process.env, []), { id: 'fp000001', source: 'env' });
    const text = JSON.stringify(b);
    for (const leak of ['admin-key-that-must-not-leak', 'hunter2', 'abc123', 'sk-live', 'proxypass', 'pw@', 'Acme internal', 'acme.internal', 'payroll-agent', 'secret message', 'gpt-x']) {
      expect(text, leak).not.toContain(leak);
    }
    expect(b.settings).toMatchObject({ CT_ADMIN_KEY: 'set', CT_LOG_LEVEL: 'warn', HTTPS_PROXY: 'set' });
    expect((b.providers as any[])[0]).toMatchObject({ kind: 'openai-compatible', catalog: 'custom', health: 'down' });
    expect((b.last_24h as any).errors).toEqual([expect.objectContaining({ code: 'provider_auth_error', http_status: 502, count: 1 })]);
  });
});
