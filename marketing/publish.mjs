/**
 * Posts an approved draft to the LinkedIn company page and X.
 *
 *   node marketing/publish.mjs <issue-body.md> <media-dir>
 *
 * Text comes from the (possibly edited) review issue; media from the rendered
 * draft. A platform without credentials is skipped, not failed. SKIP=linkedin,x
 * skips platforms already posted on an earlier try; DRY_RUN=1 prints what
 * would be sent. Writes results.json next to the media and prints it.
 *
 * LinkedIn (Community Management API, w_organization_social):
 *   LINKEDIN_ORG_ID, and LINKEDIN_ACCESS_TOKEN or
 *   LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET + LINKEDIN_REFRESH_TOKEN;
 *   LINKEDIN_VERSION (YYYYMM, optional)
 * X (OAuth 1.0a user context, read+write app):
 *   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *
 * Plain Node 24, no dependencies.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseIssueBody } from './lib/issue.mjs';

const [bodyFile, mediaDir] = process.argv.slice(2);
if (!bodyFile || !mediaDir) {
  console.error('usage: node marketing/publish.mjs <issue-body.md> <media-dir>');
  process.exit(2);
}
const env = process.env;
const DRY = env.DRY_RUN === '1';
const SKIP = new Set((env.SKIP ?? '').split(',').filter(Boolean));
const post = parseIssueBody(fs.readFileSync(bodyFile, 'utf8'));
const { made } = JSON.parse(fs.readFileSync(path.join(mediaDir, 'manifest.json'), 'utf8'));
const file = (f) => path.join(mediaDir, f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

// ================================================================ LinkedIn

const LI = 'https://api.linkedin.com/rest';
const LI_VERSION = env.LINKEDIN_VERSION || '202608';

/** LinkedIn "little text": reserved characters are escaped (links are left alone); #Word becomes a real hashtag. */
export function liText(s) {
  return s
    .split(/(#[\p{L}\p{N}_]+|https?:\/\/[^\s()<>]+)/u)
    .map((part, i) => (i % 2 ? (part[0] === '#' ? `{hashtag|\\#|${part.slice(1)}}` : part) : part.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => '\\' + c)))
    .join('');
}

async function liToken() {
  if (env.LINKEDIN_REFRESH_TOKEN && env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET) {
    const r = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.LINKEDIN_REFRESH_TOKEN, client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`LinkedIn token refresh: ${r.status} ${JSON.stringify(j)}`);
    return j.access_token;
  }
  return env.LINKEDIN_ACCESS_TOKEN;
}

async function li(token, method, url, body) {
  const r = await fetch(url.startsWith('http') ? url : LI + url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'LinkedIn-Version': LI_VERSION, 'X-Restli-Protocol-Version': '2.0.0', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`LinkedIn ${method} ${url}: ${r.status} ${text.slice(0, 500)}`);
  return { json: text ? JSON.parse(text) : {}, headers: r.headers };
}

async function liPut(url, token, buf) {
  const r = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: buf });
  if (!r.ok) throw new Error(`LinkedIn upload: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.headers.get('etag');
}

async function liUploadImage(token, owner, f) {
  const { json } = await li(token, 'POST', '/images?action=initializeUpload', { initializeUploadRequest: { owner } });
  await liPut(json.value.uploadUrl, token, fs.readFileSync(f));
  return json.value.image;
}

async function liUploadDocument(token, owner, f) {
  const { json } = await li(token, 'POST', '/documents?action=initializeUpload', { initializeUploadRequest: { owner } });
  await liPut(json.value.uploadUrl, token, fs.readFileSync(f));
  return json.value.document;
}

async function liUploadVideo(token, owner, f, poster) {
  const buf = fs.readFileSync(f);
  const { json } = await li(token, 'POST', '/videos?action=initializeUpload', { initializeUploadRequest: { owner, fileSizeBytes: buf.length, uploadCaptions: false, uploadThumbnail: !!poster } });
  const v = json.value;
  const etags = [];
  for (const ins of v.uploadInstructions) etags.push(await liPut(ins.uploadUrl, token, buf.subarray(ins.firstByte, ins.lastByte + 1)));
  if (poster && v.thumbnailUploadUrl) await liPut(v.thumbnailUploadUrl, token, fs.readFileSync(poster));
  await li(token, 'POST', '/videos?action=finalizeUpload', { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? '', uploadedPartIds: etags } });
  for (let i = 0; i < 60; i++) {
    const { json: s } = await li(token, 'GET', `/videos/${encodeURIComponent(v.video)}`);
    if (s.status === 'AVAILABLE') break;
    if (s.status === 'PROCESSING_FAILED') throw new Error('LinkedIn video processing failed');
    await sleep(5000);
  }
  return v.video;
}

async function publishLinkedIn() {
  const p = post.linkedin;
  if (!p?.text) return { skipped: 'no LinkedIn text in the issue' };
  if (!env.LINKEDIN_ORG_ID || !(env.LINKEDIN_ACCESS_TOKEN || env.LINKEDIN_REFRESH_TOKEN)) return { skipped: 'LinkedIn is not configured (LINKEDIN_ORG_ID + token secrets)' };
  const owner = `urn:li:organization:${env.LINKEDIN_ORG_ID}`;
  const body = { author: owner, commentary: liText(p.text), visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false };
  if (DRY) return { dry: true, media: p.media, body };
  const token = await liToken();
  if (p.media === 'video' && made.video) body.content = { media: { id: await liUploadVideo(token, owner, file(made.video.square), made.video.poster && file(made.video.poster)), title: p.document_title ?? '' } };
  else if (p.media === 'carousel' && made.carousel) body.content = { media: { id: await liUploadDocument(token, owner, file(made.carousel.pdf)), title: p.document_title || 'Control Tower' } };
  else if (p.media === 'cards' && made.cards.length) {
    const imgs = [];
    for (const c of made.cards) imgs.push({ id: await liUploadImage(token, owner, file(c.file)), altText: c.alt.slice(0, 4086) });
    body.content = imgs.length === 1 ? { media: imgs[0] } : { multiImage: { images: imgs } };
  }
  if (body.content?.media && !body.content.media.title) delete body.content.media.title;
  const { headers } = await li(token, 'POST', '/posts', body);
  const urn = headers.get('x-restli-id');
  return { urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}

// ================================================================ X

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** OAuth 1.0a header; `params` are query/form parameters that are part of the signature (JSON and multipart bodies are not). */
function oauth(method, url, params = {}) {
  const o = { oauth_consumer_key: env.X_API_KEY, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: env.X_ACCESS_TOKEN, oauth_version: '1.0' };
  const all = { ...params, ...o };
  const norm = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join('&');
  const base = [method.toUpperCase(), pct(url), pct(norm)].join('&');
  o.oauth_signature = crypto.createHmac('sha1', `${pct(env.X_API_SECRET)}&${pct(env.X_ACCESS_SECRET)}`).update(base).digest('base64');
  return 'OAuth ' + Object.keys(o).sort().map((k) => `${pct(k)}="${pct(o[k])}"`).join(', ');
}

async function x(method, url, { json, form, query } = {}) {
  const full = query ? `${url}?${new URLSearchParams(query)}` : url;
  const r = await fetch(full, {
    method,
    headers: { authorization: oauth(method, url, query ?? {}), ...(json ? { 'content-type': 'application/json' } : {}) },
    ...(json ? { body: JSON.stringify(json) } : form ? { body: form } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`X ${method} ${url}: ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

const X_API = 'https://api.x.com/2';

async function xUploadImage(f, alt) {
  const form = new FormData();
  form.append('media', new Blob([fs.readFileSync(f)], { type: 'image/png' }), path.basename(f));
  form.append('media_category', 'tweet_image');
  const j = await x('POST', `${X_API}/media/upload`, { form });
  if (alt) await x('POST', `${X_API}/media/metadata`, { json: { id: j.data.id, metadata: { alt_text: { text: alt.slice(0, 1000) } } } });
  return j.data.id;
}

async function xUploadVideo(f) {
  const buf = fs.readFileSync(f);
  const init = await x('POST', `${X_API}/media/upload/initialize`, { json: { media_type: 'video/mp4', total_bytes: buf.length, media_category: 'tweet_video' } });
  const id = init.data.id;
  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
    const form = new FormData();
    form.append('media', new Blob([buf.subarray(i, i + CHUNK)]), 'chunk');
    form.append('segment_index', String(seg));
    await x('POST', `${X_API}/media/upload/${id}/append`, { form });
  }
  let info = (await x('POST', `${X_API}/media/upload/${id}/finalize`)).data?.processing_info;
  while (info && ['pending', 'in_progress'].includes(info.state)) {
    await sleep((info.check_after_secs ?? 3) * 1000);
    info = (await x('GET', `${X_API}/media/upload`, { query: { command: 'STATUS', media_id: id } })).data?.processing_info;
  }
  if (info?.state === 'failed') throw new Error(`X video processing failed: ${JSON.stringify(info.error ?? info)}`);
  return id;
}

async function publishX() {
  const p = post.x;
  if (!p?.posts?.length) return { skipped: 'no X posts in the issue' };
  if (!env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_SECRET) return { skipped: 'X is not configured (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)' };
  if (DRY) return { dry: true, media: p.media, posts: p.posts };
  let media_ids = [];
  if (p.media === 'video' && made.video) media_ids = [await xUploadVideo(file(made.video.wide))];
  else if (p.media === 'cards' && made.cards.length) for (const c of made.cards.slice(0, 4)) media_ids.push(await xUploadImage(file(c.file), c.alt));
  const ids = [];
  for (const [i, text] of p.posts.entries()) {
    const body = { text };
    if (i === 0 && media_ids.length) body.media = { media_ids };
    if (i > 0) body.reply = { in_reply_to_tweet_id: ids.at(-1) };
    ids.push((await x('POST', `${X_API}/tweets`, { json: body })).data.id);
  }
  return { ids, url: `https://x.com/i/web/status/${ids[0]}` };
}

// ================================================================ run

for (const [name, fn] of [['linkedin', publishLinkedIn], ['x', publishX]]) {
  if (SKIP.has(name)) { results[name] = { skipped: 'already posted' }; continue; }
  try {
    results[name] = await fn();
  } catch (err) {
    results[name] = { error: err.message };
  }
}
fs.writeFileSync(path.join(mediaDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
if (Object.values(results).some((r) => r.error)) process.exitCode = 1;
