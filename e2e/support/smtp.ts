import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { AddressInfo } from 'node:net';

/** A real SMTP server that keeps every message it receives, parsed. */
/** With `auth`, only that username and password are accepted (over plain SMTP, for the test). */
export async function smtpCapture(auth?: { user: string; pass: string }): Promise<{ port: number; messages: ParsedMail[]; envelopes: string[][]; close(): Promise<void> }> {
  const messages: ParsedMail[] = [];
  const envelopes: string[][] = [];
  const server = new SMTPServer({
    authOptional: !auth,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    onAuth(a, _session, cb) {
      if (auth && a.username === auth.user && a.password === auth.pass) cb(null, { user: a.username });
      else cb(new Error('Invalid username or password'));
    },
    logger: false,
    onData(stream, session, done) {
      envelopes.push(session.envelope.rcptTo.map((r) => r.address));
      simpleParser(stream)
        .then((m) => {
          messages.push(m);
          done();
        })
        .catch(done);
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as AddressInfo).port;
  return { port, messages, envelopes, close: () => new Promise((r) => server.close(() => r())) };
}
