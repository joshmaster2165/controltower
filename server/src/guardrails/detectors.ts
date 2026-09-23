/**
 * Built-in content detectors for inspect gates. Each is a regex plus an
 * optional validator that removes the obvious false positives (Luhn for card
 * numbers, mod-97 for IBANs, reserved ranges for SSNs).
 *
 * These are heuristics, and the console says so: they catch the common,
 * well-formed cases (a pasted AWS key, an email address in a tool result),
 * not a determined adversary encoding data to evade them.
 */

export type DetectorCategory = 'secret' | 'pii' | 'injection';

export interface Detector {
  id: string;
  category: DetectorCategory;
  label: string;
  /** Global regex; the match (or `group`) is the sensitive span. */
  re: RegExp;
  group?: number;
  validate?: (s: string) => boolean;
  /** Placeholder used when masking. */
  mask: string;
}

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanOk(s: string): boolean {
  const v = s.replace(/\s+/g, '').toUpperCase();
  if (v.length < 15 || v.length > 34) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of code) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function ssnOk(s: string): boolean {
  const [a, b, c] = s.split('-');
  if (!a || !b || !c) return false;
  if (a === '000' || a === '666' || a[0] === '9') return false;
  return b !== '00' && c !== '0000';
}

function ipv4Ok(s: string): boolean {
  const parts = s.split('.').map(Number);
  if (parts.some((p) => p > 255)) return false;
  // Version-like strings and loopback are noise, not personal data.
  return !(parts[0] === 0 || parts[0] === 127);
}

export const SECRET_DETECTORS: Detector[] = [
  { id: 'aws_access_key', category: 'secret', label: 'AWS access key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, mask: '[SECRET:AWS_KEY]' },
  { id: 'aws_secret_key', category: 'secret', label: 'AWS secret key', re: /aws.{0,20}?(?:secret|private).{0,20}?['"=:\s]\s*([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi, group: 1, mask: '[SECRET:AWS_SECRET]' },
  { id: 'github_token', category: 'secret', label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g, mask: '[SECRET:GITHUB_TOKEN]' },
  { id: 'slack_token', category: 'secret', label: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,200}\b/g, mask: '[SECRET:SLACK_TOKEN]' },
  { id: 'slack_webhook', category: 'secret', label: 'Slack webhook URL', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g, mask: '[SECRET:SLACK_WEBHOOK]' },
  { id: 'stripe_key', category: 'secret', label: 'Stripe key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, mask: '[SECRET:STRIPE_KEY]' },
  { id: 'anthropic_key', category: 'secret', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, mask: '[SECRET:ANTHROPIC_KEY]' },
  { id: 'openai_key', category: 'secret', label: 'OpenAI API key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, mask: '[SECRET:OPENAI_KEY]' },
  { id: 'google_api_key', category: 'secret', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, mask: '[SECRET:GOOGLE_KEY]' },
  { id: 'controltower_key', category: 'secret', label: 'Control Tower key', re: /\bct_sk_[0-9A-Za-z]{32}_[0-9A-Za-z]{6}\b/g, mask: '[SECRET:CT_KEY]' },
  { id: 'npm_token', category: 'secret', label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, mask: '[SECRET:NPM_TOKEN]' },
  { id: 'private_key', category: 'secret', label: 'Private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, mask: '[SECRET:PRIVATE_KEY]' },
  { id: 'jwt', category: 'secret', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, mask: '[SECRET:JWT]' },
  { id: 'connection_string', category: 'secret', label: 'Connection string with password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s]+/g, mask: '[SECRET:CONNECTION_STRING]' },
];

export const PII_DETECTORS: Detector[] = [
  { id: 'email', category: 'pii', label: 'Email address', re: /\b[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g, mask: '[EMAIL]' },
  { id: 'phone', category: 'pii', label: 'Phone number', re: /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w.])/g, mask: '[PHONE]' },
  { id: 'credit_card', category: 'pii', label: 'Card number', re: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhn, mask: '[CARD]' },
  { id: 'us_ssn', category: 'pii', label: 'US Social Security number', re: /\b\d{3}-\d{2}-\d{4}\b/g, validate: ssnOk, mask: '[SSN]' },
  { id: 'iban', category: 'pii', label: 'IBAN', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, validate: ibanOk, mask: '[IBAN]' },
  { id: 'ip_address', category: 'pii', label: 'IP address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, validate: ipv4Ok, mask: '[IP]' },
];

/**
 * Prompt-injection phrasing. Aimed at *indirect* injection — instructions
 * smuggled into tool results, web pages and documents the agent reads — which
 * is where an MCP gateway can see what the model is about to be fed.
 */
export const INJECTION_DETECTORS: Detector[] = [
  { id: 'ignore_instructions', category: 'injection', label: 'Ignore-previous-instructions', re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|directives|guidelines)\b/gi, mask: '[REMOVED:INSTRUCTION]' },
  { id: 'role_override', category: 'injection', label: 'Role override', re: /\b(?:you are now|from now on,? you (?:are|will)|act as (?:an? )?(?:unrestricted|jailbroken|developer mode)|enter (?:developer|god|DAN) mode)\b/gi, mask: '[REMOVED:INSTRUCTION]' },
  { id: 'prompt_exfiltration', category: 'injection', label: 'System-prompt extraction', re: /\b(?:reveal|print|repeat|output|show)\b[^.\n]{0,30}\b(?:system prompt|hidden instructions|initial instructions|developer message)\b/gi, mask: '[REMOVED:INSTRUCTION]' },
  { id: 'fake_chat_markup', category: 'injection', label: 'Chat-template markup', re: /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<<SYS>>/gi, mask: '[REMOVED:MARKUP]' },
  { id: 'exfil_instruction', category: 'injection', label: 'Send-data-elsewhere instruction', re: /\b(?:send|post|upload|forward|email|exfiltrate)\b[^.\n]{0,40}\b(?:credentials?|api keys?|secrets?|passwords?|tokens?|env(?:ironment)? variables)\b[^.\n]{0,40}\b(?:to|at)\b/gi, mask: '[REMOVED:INSTRUCTION]' },
];

export const ALL_DETECTORS: Detector[] = [...SECRET_DETECTORS, ...PII_DETECTORS, ...INJECTION_DETECTORS];
export const DETECTOR_BY_ID = new Map(ALL_DETECTORS.map((d) => [d.id, d]));

/** The catalogue the console renders (no regexes over the wire). */
export function detectorCatalog(): Array<{ id: string; category: DetectorCategory; label: string }> {
  return ALL_DETECTORS.map((d) => ({ id: d.id, category: d.category, label: d.label }));
}
