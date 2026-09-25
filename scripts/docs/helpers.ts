import { expect, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Shared by the docs screenshot scripts: a real server per scenario, and screenshots with the control to click ringed. */
export const REPO = path.resolve(__dirname, '../..');
export const OUT = path.join(REPO, 'docs/images');
fs.mkdirSync(OUT, { recursive: true });

export async function startServer(port: number, env: Record<string, string>): Promise<{ url: string; stop: () => Promise<void> }> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-docs-'));
  const p: ChildProcess = spawn('node', ['server/dist/server.mjs', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, CT_DATA_DIR: data, CT_UI_DIR: path.join(REPO, 'ui/dist'), CT_LOG_LEVEL: 'warn', CT_DEMO: '0', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://localhost:${port}`;
  await expect.poll(async () => (await fetch(`${url}/health/liveliness`).catch(() => undefined))?.status, { timeout: 20_000 }).toBe(200);
  return {
    url,
    stop: async () => {
      const done = new Promise((r) => p.once('exit', r));
      p.kill('SIGTERM');
      await done;
      fs.rmSync(data, { recursive: true, force: true });
    },
  };
}

/** Save a screenshot; with `el`, outline it first so the docs can say "the highlighted button". */
export async function shot(page: Page, name: string, opts: { el?: Locator; clip?: Locator; pad?: number } = {}): Promise<void> {
  await page.waitForTimeout(250);
  const handle = opts.el ? await opts.el.elementHandle() : null;
  // The control to click: an orange ring with a soft halo, like a finger pointing at it.
  if (handle)
    await handle.evaluate((e: HTMLElement) => {
      e.dataset.docsMark = e.style.outline;
      e.style.outline = '3px solid #ff6a3d';
      e.style.outlineOffset = '3px';
      e.style.boxShadow = '0 0 0 9px rgba(255, 106, 61, 0.22)';
      e.style.borderRadius = e.style.borderRadius || '8px';
    });
  let clip;
  if (opts.clip) {
    const b = (await opts.clip.boundingBox())!;
    const pad = opts.pad ?? 16;
    const vp = page.viewportSize()!;
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    clip = { x, y, width: Math.min(vp.width - x, b.width + pad * 2), height: Math.min(vp.height - y, b.height + pad * 2) };
  }
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
  if (handle) await handle.evaluate((e: HTMLElement) => { e.style.outline = e.dataset.docsMark ?? ''; e.style.outlineOffset = ''; e.style.boxShadow = ''; });
}

/** Sidebar link by name; links with a badge read "Tower 3", so a trailing count is allowed. */
export const nav = (page: Page, name: string) => page.getByRole('link', { name: new RegExp(`^${name}( \\d+)?$`) }).click();

