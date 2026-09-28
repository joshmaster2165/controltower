import { expect } from '@playwright/test';

export const CT = 'http://127.0.0.1:4400';
const EMAIL = 'e2e@example.com';
const PASSWORD = 'e2e-password-123';

/** A small admin client for specs: the console's session cookie and CSRF token, as a person signed in. */
export const admin = {
  cookie: '',
  csrf: '',
  async signIn(): Promise<void> {
    await fetch(`${CT}/admin/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    const r = await fetch(`${CT}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    expect(r.status).toBe(200);
    this.cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    this.csrf = ((await r.json()) as { csrf: string }).csrf;
  },
  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const r = await fetch(`${CT}${path}`, {
      method,
      headers: { cookie: this.cookie, 'x-ct-csrf': this.csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text body */
    }
    return { status: r.status, body: parsed as T };
  },
  get<T = any>(path: string) {
    return this.call<T>('GET', path);
  },
  post<T = any>(path: string, body: unknown = {}) {
    return this.call<T>('POST', path, body);
  },
  patch<T = any>(path: string, body: unknown) {
    return this.call<T>('PATCH', path, body);
  },
  put<T = any>(path: string, body: unknown) {
    return this.call<T>('PUT', path, body);
  },
  del<T = any>(path: string) {
    return this.call<T>('DELETE', path);
  },
};

/** A flight as the admin API lists it, once it has finished (the event writer is batched). */
export async function flightById(id: string, timeoutMs = 5000): Promise<any> {
  const t = Date.now();
  for (;;) {
    const r = await admin.get(`/admin/api/flights/${id}`);
    const f = r.body?.flight ?? r.body;
    if (r.status === 200 && f?.status) return f;
    if (Date.now() - t > timeoutMs) return f;
    await new Promise((res) => setTimeout(res, 100));
  }
}
