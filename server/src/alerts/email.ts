import nodemailer from 'nodemailer';
import type { AlertPayload } from './alerts.js';

/**
 * Email alerts, including approval requests. Like Slack, an email carries
 * names, counts and the scope of a decision — never prompts, arguments or
 * responses — and its button only opens the approval card: approving is an
 * authenticated action in the console, so a forwarded email or a mail
 * scanner following links can't approve anything.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user?: string | undefined;
  pass?: string | undefined;
  from: string;
}

/** CT_SMTP_URL (smtp://user:pass@host:587 or smtps://…:465) and CT_SMTP_FROM, as the default for email channels. */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | undefined {
  if (!env.CT_SMTP_URL) return undefined;
  try {
    const u = new URL(env.CT_SMTP_URL);
    const secure = u.protocol === 'smtps:';
    return {
      host: u.hostname,
      port: Number(u.port) || (secure ? 465 : 587),
      secure,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      pass: u.password ? decodeURIComponent(u.password) : undefined,
      from: env.CT_SMTP_FROM || (u.username ? decodeURIComponent(u.username) : `controltower@${u.hostname}`),
    };
  } catch {
    return undefined;
  }
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const isEmail = (s: string) => EMAIL.test(s.trim());

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Subject, plain text and HTML for one alert. */
export function emailMessage(p: AlertPayload): { subject: string; text: string; html: string } {
  const list = (xs: Array<{ name: string; count: number }>) => xs.map((x) => (x.count > 1 ? `${x.name} (${x.count})` : x.name)).join(', ');
  const facts: Array<[string, string]> = [];
  if (p.agents?.length) facts.push(['Agents', list(p.agents)]);
  if (p.destinations?.length) facts.push(['Target', list(p.destinations)]);
  if (p.gate) facts.push(['Gate', p.gate.name]);
  if (p.reason) facts.push(['Reason', p.reason]);
  const link = p.approval?.url ?? p.console_url;
  const action = p.approval ? 'Review & approve' : p.trigger === 'held' ? 'Review in the Tower' : 'Open Control Tower';
  const subject = `${p.approval ? '[Approval needed] ' : ''}${p.title}`.slice(0, 200);

  const text = [
    p.title,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(p.lines ?? []),
    ...(p.approval ? ['', `Decision needed: ${p.approval.scope}.`, 'Approving happens in Control Tower, signed in. The link below only opens the request.'] : []),
    ...(link ? ['', `${action}: ${link}`] : []),
    '',
    `— Control Tower · ${p.alert_rule.name}`,
  ].join('\n');

  const row = ([k, v]: [string, string]) => `<tr><td style="padding:4px 12px 4px 0;color:#5b6b82;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;color:#0f1b2d">${esc(v)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e8f0;border-radius:12px">
<tr><td style="padding:20px 24px 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${p.approval ? '#b26a00' : '#1f5eff'};font-weight:600">${p.approval ? 'Approval needed' : 'Control Tower alert'}</td></tr>
<tr><td style="padding:4px 24px 12px;font-size:18px;line-height:1.35;font-weight:600;color:#0f1b2d">${esc(p.title)}</td></tr>
${facts.length ? `<tr><td style="padding:0 24px 8px"><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.45">${facts.map(row).join('')}</table></td></tr>` : ''}
${(p.lines ?? []).length ? `<tr><td style="padding:0 24px 8px;font-size:14px;line-height:1.5;color:#33435a">${p.lines.map(esc).join('<br>')}</td></tr>` : ''}
${p.approval ? `<tr><td style="padding:4px 24px 12px"><div style="background:#fff8ec;border-radius:8px;padding:10px 12px;font-size:14px;color:#6b4300">${esc(p.approval.scope)}</div></td></tr>` : ''}
${link ? `<tr><td style="padding:8px 24px 20px"><a href="${esc(link)}" style="display:inline-block;background:#1f5eff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">${esc(action)}</a>${p.approval ? `<div style="font-size:12px;color:#8a98ad;margin-top:10px">Approving happens in Control Tower, signed in. This link only opens the request.</div>` : ''}</td></tr>` : ''}
<tr><td style="padding:12px 24px 18px;border-top:1px solid #e3e8f0;font-size:12px;color:#8a98ad">Control Tower · ${esc(p.alert_rule.name)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/** Send one alert. Errors carry the SMTP response code when there is one (4xx: try again, 5xx: don't). */
export async function sendEmail(smtp: SmtpConfig, to: string[], p: AlertPayload, timeoutMs = 15_000): Promise<{ ok: boolean; status?: number | undefined; error?: string | undefined }> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  const m = emailMessage(p);
  try {
    await transport.sendMail({ from: smtp.from, to, subject: m.subject, text: m.text, html: m.html, headers: { 'X-CT-Alert': p.id } });
    return { ok: true, status: 250 };
  } catch (err) {
    const e = err as { responseCode?: number; message?: string; code?: string };
    return { ok: false, status: e.responseCode, error: e.message ?? e.code ?? String(err) };
  } finally {
    transport.close();
  }
}
