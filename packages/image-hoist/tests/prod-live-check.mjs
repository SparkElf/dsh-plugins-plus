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

const zstdcat = (file) => execFileSync('zstdcat', [file], { encoding: 'utf8', maxBuffer: 2 ** 31 - 1 });

const ROOT = '/root/.dsh/sessions/--root-projects--';
const PROBE = '/tmp/hoist-probe.png';
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

  // Wait for the turn to finish, judged by the session's own terminal marker.
  // Log size is not a completion signal: a slow tool call (a 600x300 probe read
  // takes tens of seconds) leaves the file unchanged long enough to look settled,
  // and reading there reports a healthy hoist as a miss.
  let session = null;
  let settled = false;
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(5000);
    if (session === null) {
      const now = readdirSync(ROOT)
        .filter((d) => !before.has(d))
        .map((d) => ({ d, m: statSync(join(ROOT, d)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (now.length > 0) session = now[0].d;
    }
    if (session === null) continue;
    const file = join(ROOT, session, 'session.v4.jsonl.zstd');
    try {
      settled = zstdcat(file).includes('"turn/end"');
    } catch { /* not flushed yet */ }
    if (settled) break;
  }
  if (session === null) throw new Error('no new session appeared');
  if (!settled) throw new Error('the turn never reached turn/end');

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

  // The probe carries a fixed four-digit number: the model naming it is what proves
  // the image reached the provider, because a route billed as base64 text cannot read
  // the picture. The durable log deliberately still holds the image on its tool result
  // -- the hoist is a projection applied when the request is composed, so the raw log
  // is expected to keep both copies.
  const EXPECTED = '7391';
  const readIt = answer.includes(EXPECTED);
  const hoistTargets = hoists.flatMap((h) => (h.data?.targets ?? []));
  const imagesOnUser = events.filter((e) => e.type === 'user/message' &&
    (e.data?.message?.content ?? []).some((b) => b.type === 'image'));

  // A base64-billed route spends roughly one token per four bytes of image on top of the
  // text baseline; a hoisted one spends a couple of hundred tokens for the whole picture.
  const probeBytes = existsSync(PROBE) ? statSync(PROBE).size : null;
  const inputs = events
    .filter((e) => e.type === 'assistant/message' && typeof e.data?.usage?.inputTokens === 'number')
    .map((e) => e.data.usage.inputTokens);
  const worst = inputs.length > 0 ? Math.max(...inputs) : null;

  console.log('PROD-INFO session:', session);
  console.log('PROD-INFO image/hoist events :', hoists.length, JSON.stringify(hoistTargets));
  console.log('PROD-INFO images left on tool results:', toolImages.length, '(expected: the log keeps its copy)');
  // The raw log keeps every image on its tool result: the hoist is a projection applied
  // while the request is composed, so the projected view -- not this file -- carries the
  // copy that rides on the user message.
  console.log('PROD-INFO images on user messages in the raw log:', imagesOnUser.length, '(projection only; 0 here is expected)');
  console.log('PROD-INFO model answer:', JSON.stringify(answer.slice(-60)), 'expected', EXPECTED);
  console.log('PROD-INFO largest request input:', worst, 'tokens for a', probeBytes, 'byte probe',
    `(base64 billing would add ~${probeBytes ? Math.round(probeBytes / 4) : '?'} tokens)`);
  console.log('PROD-INFO plugin live:', hoists.length > 0 ? 'YES' : 'NO');
  outcome = hoists.length > 0 && hoistTargets.length > 0 && readIt
    ? 'PROD-PASS'
    : `PROD-FAIL hoists=${hoists.length} targets=${hoistTargets.length} readIt=${readIt}`;
} catch (error) {
  outcome = `PROD-FAIL ${String(error?.message ?? error).slice(0, 180)}`;
} finally {
  await browser.close();
}
console.log(outcome);
process.exit(outcome.startsWith('PROD-FAIL') ? 1 : 0);
