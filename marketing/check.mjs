/**
 * Checks a brief without rendering it (no dependencies needed):
 *
 *   node marketing/check.mjs marketing/drafts/<date>.json
 */
import fs from 'node:fs';
import { validateBrief, xLength } from './lib/brief.mjs';

const f = process.argv[2];
if (!f) { console.error('usage: node marketing/check.mjs <brief.json>'); process.exit(2); }
let b;
try { b = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error(`not valid JSON: ${e.message}`); process.exit(1); }
const problems = validateBrief(b);
if (problems.length) { console.error('✗ ' + problems.join('\n✗ ')); process.exit(1); }
console.log(`✓ ${f}: LinkedIn ${b.linkedin.text.length} chars; X ${b.x.posts.map(xLength).join(' + ')} weighted chars`);
