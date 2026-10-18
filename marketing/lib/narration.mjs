/**
 * Voice-over for recorded takes. Each line is spoken by a text-to-speech model through a Control Tower (its
 * /v1/audio/speech pass-through), generated before the take and cached by its text, so a scene can be held until its
 * line has been said: the voice and the picture stay together. After the take, the lines are mixed onto the video at
 * the moments they were started.
 *
 *   const n = narrator({ dir });            // CT_TTS_URL + CT_TTS_KEY (or CT_TTS_KEY_FILE): a Control Tower with a TTS model
 *   await n.prepare({ map: 'This is…', … }); // before recording
 *   n.say('map');  …  await n.done();        // in a scene: start the line; wait until it has been said
 *   mixNarration(video, n.cues, startMs, out);
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { duration, ffmpeg } from './stage.mjs';

const VOICE = process.env.CT_TTS_VOICE ?? 'sage';
const MODEL = process.env.CT_TTS_MODEL ?? 'openai/gpt-4o-mini-tts';
const STYLE = process.env.CT_TTS_STYLE ?? 'A calm, confident, friendly product narrator for a developer tool. Clear and unhurried, warm but not salesy. American English.';

export function narrator({ dir }) {
  const url = (process.env.CT_TTS_URL ?? 'https://controltower-production-8581.up.railway.app').replace(/\/+$/, '');
  const key = process.env.CT_TTS_KEY ?? (process.env.CT_TTS_KEY_FILE ? fs.readFileSync(process.env.CT_TTS_KEY_FILE, 'utf8').trim() : '');
  if (!key) throw new Error('narration needs CT_TTS_KEY (or CT_TTS_KEY_FILE): a key for a Control Tower that serves a text-to-speech model');
  fs.mkdirSync(dir, { recursive: true });
  const lines = new Map(); // id → { file, ms }
  const cues = []; // { id, file, at, ms }
  let endsAt = 0;
  return {
    cues,
    /** Generate (or reuse) every line; returns each one's length in ms. */
    async prepare(script) {
      for (const [id, text] of Object.entries(script)) {
        const hash = crypto.createHash('sha256').update(`${MODEL}|${VOICE}|${STYLE}|${text}`).digest('hex').slice(0, 12);
        const file = path.join(dir, `${id}-${hash}.mp3`);
        if (!fs.existsSync(file)) {
          const r = await fetch(`${url}/v1/audio/speech`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, instructions: STYLE, response_format: 'mp3' }) });
          if (!r.ok) throw new Error(`speech for "${id}": ${r.status} ${(await r.text()).slice(0, 200)}`);
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        }
        lines.set(id, { file, ms: Math.round(duration(file) * 1000) });
      }
      return Object.fromEntries([...lines].map(([id, l]) => [id, l.ms]));
    },
    /** Start a line now (its moment is noted for the mix). */
    say(id) {
      const l = lines.get(id);
      if (!l) throw new Error(`no line "${id}"`);
      const at = Date.now();
      cues.push({ id, file: l.file, at, ms: l.ms });
      endsAt = at + l.ms;
      return l.ms;
    },
    /** Wait until the line being said has finished, plus a breath. */
    async done(pad = 450) {
      const left = endsAt + pad - Date.now();
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    },
  };
}

/** Lay the lines over the video, each at its moment (relative to the take's first frame); video copied as it is. */
export function mixNarration(video, cues, startMs, out) {
  if (!cues.length) return fs.copyFileSync(video, out);
  const inputs = cues.flatMap((c) => ['-i', c.file]);
  const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.max(0, c.at - startMs)}|${Math.max(0, c.at - startMs)},volume=1.0[a${i}]`);
  const mix = `${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad[a]`;
  ffmpeg(['-i', video, ...inputs, '-filter_complex', [...delays, mix].join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-shortest', '-movflags', '+faststart', out]);
}
