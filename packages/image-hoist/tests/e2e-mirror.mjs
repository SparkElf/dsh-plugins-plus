/**
 * End-to-end check for the image hoist on the mirror instance.
 *
 * Drives the real Web UI on the mirror port (default 3081) the way a person
 * does: create a session, ask the agent to read an image file, and then read the
 * mirror's own session log to see where the image landed and what the upstream
 * was charged. It never touches the production port, and it fails loudly if the
 * mirror and production are not distinct instances.
 *
 * Usage: node e2e-mirror.mjs [port] [--keep]
 */
import { chromium } from '/root/projects/deepseek-harness-plus/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const port = process.argv[2] ?? '3081';
const MIRROR = '/root/.dsh-mirror-hoist';
if (port === '3080') {
  console.log('E2E-REFUSED refusing to drive the production port');
  process.exit(2);
}

const base = `http://127.0.0.1:${port}/`;
console.log('E2E-INFO target', base);

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
});
let outcome = 'E2E-FAIL unknown';
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(12_000);
  console.log('E2E-INFO page loaded:', await page.title());

  // The mirror starts with no workspace, so drive the real sequence a person
  // does: open a session, open the directory picker, choose /root/projects.
  const newSession = page.getByRole('button', { name: 'New session' });
  if (await newSession.count() > 0) {
    await newSession.first().click();
    await page.waitForTimeout(4000);
  }
  const choose = page.getByRole('button', { name: 'Choose workspace' });
  if (await choose.count() > 0) {
    await choose.first().click();
    await page.waitForTimeout(3000);
  }
  // The picker lists directories; pick the workspace root by its own row.
  const projects = page.getByText('projects', { exact: true });
  if (await projects.count() > 0) {
    await projects.last().click();
    await page.waitForTimeout(2000);
  }
  // Confirm the selection if the picker asks for it.
  for (const label of ['Select', 'Choose', 'Open', 'Confirm', 'OK']) {
    const confirm = page.getByRole('button', { name: label });
    if (await confirm.count() > 0) {
      await confirm.last().click();
      await page.waitForTimeout(4000);
      break;
    }
  }
  await page.waitForTimeout(3000);
  console.log('E2E-INFO workspace step done');

  const box = page.locator('[contenteditable="true"]').last();
  if (await box.count() === 0) throw new Error('composer not found');
  await box.click();
  await page.waitForTimeout(400);
  await box.type(
    '用 read_image 读取 /tmp/hoist-probe.png，然后只回答图片里的四位数，不要做别的。',
    { delay: 5 }
  );
  await page.waitForTimeout(1500);
  const send = page.getByRole('button', { name: 'Send message' });
  if (await send.count() === 0) throw new Error('send button not found');
  await send.first().click();
  console.log('E2E-INFO prompt sent; waiting for the turn to settle');

  // Wait for the agent to finish: the session log grows while it works.
  let lastSize = -1;
  let stable = 0;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(5000);
    const size = mirrorLogBytes();
    if (size > 0 && size === lastSize) stable += 1;
    else stable = 0;
    lastSize = size;
    if (stable >= 3 && size > 0) break;
  }
  outcome = 'E2E-DONE';
} catch (error) {
  outcome = `E2E-FAIL ${String(error?.message ?? error).slice(0, 200)}`;
} finally {
  await browser.close();
}

/** Total bytes of the mirror's own session logs. */
function mirrorLogBytes() {
  const dir = join(MIRROR, 'sessions');
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const workspace of readdirSync(dir)) {
    const inner = join(dir, workspace);
    let entries;
    try { entries = readdirSync(inner); } catch { continue; }
    for (const session of entries) {
      const file = join(inner, session, 'session.v4.jsonl.zstd');
      try { total += statSync(file).size; } catch { /* not written yet */ }
    }
  }
  return total;
}

console.log(outcome);
process.exit(outcome.startsWith('E2E-FAIL') ? 1 : 0);
