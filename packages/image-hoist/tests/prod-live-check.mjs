/**
 * Prove the image-hoist plugin is live on the production 3080 runtime.
 *
 * Reads nothing destructive: it opens the UI, creates one session, asks the
 * agent to read a probe image, waits for the turn to settle, and reports where
 * the image ended up in that session's own log. The session it creates is
 * reported by id so the operator can keep or remove it.
 */
import { chromium } from '/root/projects/deepseek-harness-plus/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/root/.dsh/sessions/--root-projects--';
const before = new Set(readdirSync(ROOT));

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
});
let outcome = 'PROD-FAIL unknown';
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(12_000);

  const newSession = page.getByRole('button', { name: 'New session' });
  if (await newSession.count() > 0) {
    await newSession.first().click();
    await page.waitForTimeout(5000);
  }
  const box = page.locator('[contenteditable="true"]').last();
  if (await box.count() === 0) throw new Error('composer not found');
  await box.click();
  await page.waitForTimeout(400);
  await box.type('用 read_image 读取 /tmp/hoist-probe.png，只回答图片里的四位数，不要做别的。', { delay: 4 });
  await page.waitForTimeout(1500);
  const send = page.getByRole('button', { name: 'Send message' });
  if (await send.count() === 0) throw new Error('send button not found');
  await send.first().click();
  console.log('PROD-INFO prompt sent');

  // Wait for the new session's log to stop growing.
  let session = null;
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 70; i += 1) {
    await page.waitForTimeout(5000);
    if (session === null) {
      const now = readdirSync(ROOT).filter((d) => !before.has(d));
      if (now.length > 0) session = now[0];
    }
    if (session === null) continue;
    const file = join(ROOT, session, 'session.v4.jsonl.zstd');
    let size = 0;
    try { size = statSync(file).size; } catch { /* not flushed yet */ }
    if (size > 0 && size === last) stable += 1; else stable = 0;
    last = size;
    if (stable >= 3) break;
  }
  if (session === null) throw new Error('no new session appeared');

  const file = join(ROOT, session, 'session.v4.jsonl.zstd');
  const text = execFileSync('zstdcat', [file], { encoding: 'utf8', maxBuffer: 2 ** 31 - 1 });
  const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const hoists = events.filter((e) => e.type === 'image/hoist');
  const toolImages = events.filter((e) => e.type === 'tool/result' &&
    (e.data?.message?.content ?? []).some((b) => b.type === 'image'));
  let answer = '';
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    const t = (e.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (t.trim().length > 0) answer = t.trim();
  }

  console.log('PROD-INFO session:', session);
  console.log('PROD-INFO image/hoist events :', hoists.length, JSON.stringify(hoists.map((h) => h.data)));
  console.log('PROD-INFO tool results with image:', toolImages.length);
  console.log('PROD-INFO model answer:', JSON.stringify(answer.slice(-60)));
  console.log('PROD-INFO plugin live:', hoists.length > 0 ? 'YES' : 'NO');
  outcome = hoists.length > 0 ? 'PROD-PASS' : 'PROD-FAIL plugin did not hoist';
} catch (error) {
  outcome = `PROD-FAIL ${String(error?.message ?? error).slice(0, 180)}`;
} finally {
  await browser.close();
}
console.log(outcome);
process.exit(outcome.startsWith('PROD-FAIL') ? 1 : 0);
