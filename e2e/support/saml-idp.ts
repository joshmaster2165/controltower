import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

// xml-crypto is the server's dependency; tests borrow it to sign like a real IdP.
const req = createRequire(path.resolve('server/package.json'));
const { SignedXml } = req('xml-crypto') as { SignedXml: new (o: Record<string, unknown>) => { addReference(o: Record<string, unknown>): void; computeSignature(xml: string, o?: Record<string, unknown>): void; getSignedXml(): string } };

/** A SAML IdP for tests: a key and self-signed certificate, and signed responses made to order. */
export interface TestSamlIdp {
  entityId: string;
  ssoUrl: string;
  cert: string;
  /** Another certificate's key, for "signed by someone else". */
  otherKey: string;
  key: string;
}

export function testSamlIdp(): TestSamlIdp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-idp-'));
  const make = (name: string) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-days', '2', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, `${name}.key`), 'utf8'), cert: fs.readFileSync(path.join(dir, `${name}.crt`), 'utf8') };
  };
  const main = make('test-saml-idp');
  const other = make('someone-else');
  return { entityId: 'https://idp.test.example/saml', ssoUrl: 'https://idp.test.example/sso', cert: main.cert, key: main.key, otherKey: other.key };
}

/** The AuthnRequest in an HTTP-Redirect sign-in URL: its ID, where the answer goes, and the RelayState. */
export function readAuthnRequest(url: string): { id: string; acs: string; issuer: string; relayState: string } {
  const u = new URL(url);
  const xml = zlib.inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
  return {
    id: /\sID="([^"]+)"/.exec(xml)?.[1] ?? '',
    acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] ?? '',
    issuer: />([^<]+)<\/saml:Issuer>/.exec(xml)?.[1] ?? '',
    relayState: u.searchParams.get('RelayState') ?? '',
  };
}

export interface ResponseSpec {
  acs: string;
  audience: string;
  inResponseTo: string;
  nameID: string;
  email?: string;
  groups?: string[];
  issuer?: string;
  /** Minutes the assertion is valid from now (negative: already expired). */
  validMinutes?: number;
  sign?: 'assertion' | 'none' | 'other-key';
  /** Change the signed XML afterwards (tampering, signature wrapping). */
  after?: (xml: string) => string;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

export function assertionXml(idp: TestSamlIdp, s: ResponseSpec, id = `_a${crypto.randomBytes(8).toString('hex')}`): string {
  const now = new Date();
  const until = new Date(now.getTime() + (s.validMinutes ?? 5) * 60_000);
  const iso = (d: Date) => d.toISOString();
  const attr = (name: string, values: string[]) => `<saml:Attribute Name="${esc(name)}">${values.map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`;
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${esc(s.issuer ?? idp.entityId)}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${esc(s.nameID)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${esc(s.inResponseTo)}" NotOnOrAfter="${iso(until)}" Recipient="${esc(s.acs)}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(until)}"><saml:AudienceRestriction><saml:Audience>${esc(s.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${s.email ? attr('email', [s.email]) : ''}${s.groups ? attr('groups', s.groups) : ''}</saml:AttributeStatement></saml:Assertion>`;
}

function signAssertion(xml: string, key: string, cert: string): string {
  const sig = new SignedXml({ privateKey: key, publicCert: cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}

/** A base64 SAMLResponse, as an IdP would post it. */
export function samlResponse(idp: TestSamlIdp, s: ResponseSpec): string {
  let assertion = assertionXml(idp, s);
  if ((s.sign ?? 'assertion') === 'assertion') assertion = signAssertion(assertion, idp.key, idp.cert);
  if (s.sign === 'other-key') assertion = signAssertion(assertion, idp.otherKey, idp.cert);
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${esc(s.acs)}" InResponseTo="${esc(s.inResponseTo)}"><saml:Issuer>${esc(s.issuer ?? idp.entityId)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  if (s.after) xml = s.after(xml);
  return Buffer.from(xml).toString('base64');
}
