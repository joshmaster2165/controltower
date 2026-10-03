import nodemailer from 'nodemailer';
import type { Kysely } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/schema.js';
import { isEmail, type SmtpConfig } from '../alerts/email.js';

/**
 * Emails to the person who asked, about their own held request: when it has waited a while (they may have stopped
 * watching), and then how it ended. Nothing for a request approved within the wait: they saw the answer arrive.
 * Like alert emails, they carry the gate, the model or tool and the person's tool and computer — never the prompt —
 * and link to My requests.
 */
export interface RequesterNotify {
  held(approvalId: string): void;
  decided(approvalId: string, status: 'approved' | 'denied' | 'expired', by: string | undefined, note: string | null | undefined): void;
}

const APPS: Record<string, string> = { 'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot CLI' };

export class RequesterMail implements RequesterNotify {
  constructor(
    private readonly deps: {
      db: Kysely<Database>;
      /** The server to send through: CT_SMTP_URL, or else an email alert channel's. */
      smtp: () => SmtpConfig | undefined;
      publicUrl: string;
      label: string;
      afterMs: number;
      enabled: boolean;
      ruleName: (id: string) => string | undefined;
      log: () => FastifyBaseLogger;
    },
  ) {}

  held(approvalId: string): void {
    if (!this.deps.enabled) return;
    setTimeout(() => void this.remind(approvalId).catch((err) => this.deps.log().warn({ err, approvalId }, 'requester email failed')), this.deps.afterMs).unref();
  }

  decided(approvalId: string, status: 'approved' | 'denied' | 'expired', by: string | undefined, note: string | null | undefined): void {
    if (!this.deps.enabled) return;
    void this.outcome(approvalId, status, by, note).catch((err) => this.deps.log().warn({ err, approvalId }, 'requester email failed'));
  }

  private async card(id: string) {
    return this.deps.db.selectFrom('approvals').selectAll().where('id', '=', id).executeTakeFirst();
  }

  private async remind(id: string): Promise<void> {
    const a = await this.card(id);
    if (!a || a.status !== 'pending' || a.notified_at || !a.requester || !isEmail(a.requester)) return;
    // Once only, even with several instances: the one that marks it sends it.
    const won = await this.deps.db.updateTable('approvals').set({ notified_at: Date.now() }).where('id', '=', id).where('notified_at', 'is', null).executeTakeFirst();
    if (Number(won.numUpdatedRows ?? 0) !== 1) return;
    await this.send(a.requester, 'Your request is waiting for approval', ["It's been sent to an approver. You'll get another email when they decide."], a);
  }

  private async outcome(id: string, status: 'approved' | 'denied' | 'expired', by: string | undefined, note: string | null | undefined): Promise<void> {
    const a = await this.card(id);
    if (!a?.notified_at || !a.requester || !isEmail(a.requester)) return;
    const app = a.client ? APPS[a.client] ?? a.client : 'your tool';
    if (status === 'approved') await this.send(a.requester, `Your request was approved${by ? ` by ${by}` : ''}`, [`If ${app} stopped waiting, send the same message again: it goes through.`], a);
    else if (status === 'denied') await this.send(a.requester, `Your request was denied${by && by !== 'Control Tower' ? ` by ${by}` : ''}`, [note ? `Their note: ${note}` : 'No note was given.'], a);
    else await this.send(a.requester, 'Your request expired before anyone approved it', ['Send it again to ask again.'], a);
  }

  private async send(to: string, title: string, lines: string[], a: { rule_id: string | null; target: string; client: string | null; device?: string | null | undefined }): Promise<void> {
    const smtp = this.deps.smtp();
    if (!smtp) return;
    const target = (JSON.parse(a.target) as { name?: string }).name ?? '';
    const facts: Array<[string, string]> = [];
    if (a.rule_id) facts.push(['Gate', this.deps.ruleName(a.rule_id) ?? a.rule_id]);
    if (target) facts.push(['For', target]);
    if (a.client || a.device) facts.push(['From', [a.client ? APPS[a.client] ?? a.client : '', a.device ? `on ${a.device}` : ''].filter(Boolean).join(' ')]);
    const link = `${this.deps.publicUrl.replace(/\/$/, '')}/#/requests`;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const text = [title, '', ...facts.map(([k, v]) => `${k}: ${v}`), '', ...lines, '', `Your requests: ${link}`, '', `— ${this.deps.label}`].join('\n');
    const html = `<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e8f0;border-radius:12px">
<tr><td style="padding:20px 24px 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#1f5eff;font-weight:600">${esc(this.deps.label)}</td></tr>
<tr><td style="padding:4px 24px 12px;font-size:18px;line-height:1.35;font-weight:600;color:#0f1b2d">${esc(title)}</td></tr>
<tr><td style="padding:0 24px 8px"><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.45">${facts.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#5b6b82;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;color:#0f1b2d">${esc(v)}</td></tr>`).join('')}</table></td></tr>
<tr><td style="padding:0 24px 8px;font-size:14px;line-height:1.5;color:#33435a">${lines.map(esc).join('<br>')}</td></tr>
<tr><td style="padding:8px 24px 20px"><a href="${esc(link)}" style="display:inline-block;background:#1f5eff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Your requests</a></td></tr>
</table></td></tr></table></body></html>`;
    const transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}), connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000 });
    try {
      await transport.sendMail({ from: smtp.from, to, subject: title, text, html });
    } finally {
      transport.close();
    }
  }
}
