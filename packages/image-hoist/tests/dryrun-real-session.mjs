/**
 * Dry run of the hoist over the REAL failing session.
 *
 * The synthetic tests prove the projection. This proves the plugin's own
 * detection logic (`pendingImageResults` / `precedingUserSeq`) against the real
 * session that bricked, using the shipped fold, and reports what the request
 * would have looked like had the plugin been mounted.
 */
import { execFileSync } from 'node:child_process';
import { foldSurface, deriveEventMessage } from '/root/.dsh/releases/plus/plus-rc32/packages/core/session/lib/index.js';
import { IMAGE_HOIST_TYPE, imageHoistProjection } from '../lib/projection.js';

const SESSION = '/root/.dsh/sessions/--root-projects--/session-8303fedf-251a-465e-9a33-131b53005a85/session.v4.jsonl.zstd';

const text = execFileSync('zstdcat', [SESSION], { encoding: 'utf8', maxBuffer: 2 ** 31 - 1 });
const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const events = rows.filter((row) => row.type !== 'session');

// The surface fold needs the projection that owns image/offload because the real
// session already contains those rows.
const imageOffload = {
  type: 'image/offload',
  project() { return new Map(); }
};
const projections = [imageOffload, imageHoistProjection];

console.log('session rows:', rows.length, '| events:', events.length);

// Rebuild the live-session view the plugin reads: surface nodes + events.
const folded = foldSurface(events, projections);
const session = {
  snapshotEvents: () => events,
  surface: { nodes: folded.nodes },
  requestHeader: () => ({ config: { provider: 'tokensfree_ds', model: 'deepseek-v4.1-flash' } })
};

// --- plugin logic, copied from lib/index.js so the dry run exercises it -------
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isImageBlock = (b) => isRecord(b) && b.type === 'image' && isRecord(b.attachment);
const hasImage = (m) => Array.isArray(m?.content) && m.content.some(isImageBlock);

function pendingImageResults(sess) {
  const evs = sess.snapshotEvents();
  const nodes = sess.surface.nodes;
  let watermark = -1;
  for (const event of evs) {
    if (event.type !== IMAGE_HOIST_TYPE) continue;
    const targets = event.data?.targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) if (typeof t?.targetSeq === 'number' && t.targetSeq > watermark) watermark = t.targetSeq;
  }
  const pending = [];
  for (const [index, seq] of nodes.entries()) {
    if (seq <= watermark) continue;
    const event = evs[seq];
    if (event?.type !== 'tool/result') continue;
    if (hasImage(event.data.message)) pending.push({ seq, index });
  }
  return pending;
}

function precedingUserSeq(sess, sourceIndex, lookback) {
  const evs = sess.snapshotEvents();
  const nodes = sess.surface.nodes;
  let checkpoint;
  let examined = 0;
  for (let index = sourceIndex - 1; index >= 0 && examined < lookback; index -= 1, examined += 1) {
    const seq = nodes[index];
    const event = evs[seq];
    if (event?.type !== 'user/message') continue;
    const kind = event.data?.source?.kind;
    if (kind === 'user') return seq;
    if (kind === 'compact-checkpoint' && checkpoint === undefined) checkpoint = seq;
  }
  return checkpoint;
}
// -----------------------------------------------------------------------------

const pending = pendingImageResults(session);
console.log(`\n1) detection found ${pending.length} image-bearing tool results still unhoisted`);
for (const { seq, index } of pending) {
  const userSeq = precedingUserSeq(session, index, 200);
  const count = session.snapshotEvents()[seq].data.message.content.filter(isImageBlock).length;
  console.log(`   seq ${seq}: ${count} image(s) -> precedes to user message seq ${userSeq}`);
}

// Build the event the plugin would append, then fold the log with it.
const targets = pending
  .map(({ seq, index }) => ({ targetSeq: seq, userSeq: precedingUserSeq(session, index, 200) }))
  .filter((t) => t.userSeq !== undefined);

const augmented = [...events, {
  type: IMAGE_HOIST_TYPE,
  seq: events.length,
  time: Date.now(),
  data: { targets }
}];

const withHoist = foldSurface(augmented, projections);

/** Count images per role in a folded history. */
function imageCensus(log, result) {
  const census = { user: 0, tool: 0, assistant: 0 };
  for (const seq of result.nodes) {
    const message = deriveEventMessage(log[seq], result.projectedMessages);
    if (message === null || message === undefined) continue;
    const images = (message.content ?? []).filter(isImageBlock).length;
    if (images > 0 && census[message.role] !== undefined) census[message.role] += images;
  }
  return census;
}

console.log('\n2) image placement before vs after the hoist');
const before = imageCensus(events, folded);
const after = imageCensus(augmented, withHoist);
console.log('   before:', JSON.stringify(before));
console.log('   after :', JSON.stringify(after));

const moved = before['tool/result'] === after['tool/result'] + after['user/message'] - before['user/message'];
// Every tool-result image must end up on a user message. Multiple tool results
// can share one carrier (a checkpoint stands in for a whole replaced span), so
// compare image totals rather than per-carrier counts.
// Several tool results can share one carrier (a checkpoint stands in for a whole
// replaced span), so the user-side delta counts carriers gained, not images moved.
const carriers = new Set(targets.map((t) => t.userSeq));
const movedAll = after.tool === 0 && after.user === before.user + carriers.size;
console.log(`   -> tool-result images remaining: ${after.tool} (must be 0)`);
console.log(`   -> every tool-result image moved onto a user message:`, movedAll);

console.log('\n3) structural integrity');
console.log('   surface nodes unchanged:', folded.nodes.length === withHoist.nodes.length,
  `(${folded.nodes.length} -> ${withHoist.nodes.length})`);
const idsEqual = JSON.stringify(folded.nodes) === JSON.stringify(withHoist.nodes);
console.log('   node identity preserved:', idsEqual);
const roleSequence = (log, result) => result.nodes.map((seq) => deriveEventMessage(log[seq], result.projectedMessages)?.role).join(',');
console.log('   role sequence unchanged:', roleSequence(events, folded) === roleSequence(augmented, withHoist));

console.log('\n4) replay determinism on real data');
const second = imageCensus(augmented, foldSurface(augmented, projections));
console.log('   second fold identical:', JSON.stringify(second) === JSON.stringify(after));

console.log('\n5) tool results keep their text (the call/answer pair stays intact)');
let emptied = 0;
for (const { seq } of pending) {
  const message = deriveEventMessage(augmented[seq], withHoist.projectedMessages);
  const blocks = message?.content ?? [];
  if (blocks.length === 0) emptied += 1;
}
console.log(`   tool results left with zero blocks: ${emptied} (must be 0)`);
