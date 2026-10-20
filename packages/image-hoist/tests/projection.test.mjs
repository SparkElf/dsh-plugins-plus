import { readFileSync } from 'node:fs';
/**
 * Offline checks for the image/hoist projection, run against the shipped
 * `foldSurface` so the projection is exercised through the real fold rather than
 * a reimplementation of it. Run with:
 *   node --experimental-vm-modules test/projection.test.mjs
 */
import { foldSurface, deriveEventMessage } from '/root/.dsh/releases/plus/plus-rc32/packages/core/session/lib/index.js';
import { IMAGE_HOIST_TYPE, imageHoistProjection } from '../lib/projection.js';
import { hoistedSeqs } from '../lib/index.js';

const IMG = (n) => ({
  type: 'image',
  attachment: { attachmentId: `sha256:${String(n).padStart(4, '0')}`, mediaType: 'image/png', bytes: 100, width: 10, height: 10 }
});
const event = (seq, type, data, extra = {}) => ({ seq, type, time: 1790000000000 + seq, data, ...extra });

/** A turn whose tool result carries one image, as read_image produces. */
function baseLog({ images = 1 } = {}) {
  return [
    event(0, 'system/message', { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' }),
    event(1, 'user/message', { content: [{ type: 'text', text: 'look at this' }], role: 'user' }, { surfaceOp: 'append' }),
    event(2, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] } }, { surfaceOp: 'append' }),
    event(3, 'tool/result', {
      message: {
        role: 'tool', toolCallId: 'c1',
        content: [{ type: 'text', text: 'read ok' }, ...Array.from({ length: images }, (_, i) => IMG(i + 1))]
      }
    }, { surfaceOp: 'append' })
  ];
}

// The plugin writes the marker, so a fixture that omits it would test a log the plugin never
// produces -- and would pass while a real session became unreadable to a reader without this
// plugin mounted.
const hoistEvent = (seq, targets) => event(seq, IMAGE_HOIST_TYPE, { targets }, { ignorable: true });

/** Render history the way a request would see it. */
function history(log, result) {
  return result.nodes.map((seq) => {
    const message = deriveEventMessage(log[seq], result.projectedMessages);
    const types = (message?.content ?? []).map((block) => block.type).join('+');
    return `${seq}:${message?.role}[${types}]`;
  });
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual  : ${JSON.stringify(actual)}`);
  }
};

const fold = (log) => foldSurface(log, [imageHoistProjection]);

console.log('\n1) baseline: no hoist recorded — image stays on the tool result');
{
  const log = baseLog();
  const rendered = history(log, fold(log));
  check('history unchanged', rendered, ['0:system[text]', '1:user[text]', '2:assistant[tool-call]', '3:tool[text+image]']);
}

console.log('\n2) one hoist: image moves to the user message, tool result keeps its text');
{
  const log = [...baseLog(), hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }])];
  const rendered = history(log, fold(log));
  check('image hoisted, structure intact', rendered, ['0:system[text]', '1:user[text+image]', '2:assistant[tool-call]', '3:tool[text]']);
}

console.log('\n3) the surface node list is preserved (a projection on tool/result would drop seq 3)');
{
  const log = [...baseLog(), hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }])];
  check('nodes keep every message', fold(log).nodes, [0, 1, 2, 3]);
}

console.log('\n4) several images in one result all move together');
{
  const log = [...baseLog({ images: 3 }), hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }])];
  const result = fold(log);
  const user = deriveEventMessage(log[1], result.projectedMessages);
  check('three images on the user message', user.content.map((b) => b.type), ['text', 'image', 'image', 'image']);
  const tool = deriveEventMessage(log[3], result.projectedMessages);
  check('tool result keeps only its text', tool.content.map((b) => b.type), ['text']);
}

console.log('\n5) two separate tool results hoist onto their own user messages');
{
  const log = [
    ...baseLog(),
    hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }]),
    event(5, 'user/message', { content: [{ type: 'text', text: 'and this one' }], role: 'user' }, { surfaceOp: 'append' }),
    event(6, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read_image', arguments: '{}' }] } }, { surfaceOp: 'append' }),
    event(7, 'tool/result', { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'ok2' }, IMG(2)] } }, { surfaceOp: 'append' }),
    hoistEvent(8, [{ targetSeq: 7, userSeq: 5 }])
  ];
  check('each image lands on its own turn', history(log, fold(log)), [
    '0:system[text]', '1:user[text+image]', '2:assistant[tool-call]', '3:tool[text]',
    '5:user[text+image]', '6:assistant[tool-call]', '7:tool[text]'
  ]);
}

console.log('\n6) replay is deterministic: folding twice yields the same history');
{
  const log = [...baseLog(), hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }])];
  const first = history(log, fold(log));
  const second = history(log, fold(log));
  check('identical across folds', second, first);
}

console.log('\n7) plugin not mounted: an unknown ignorable event leaves history intact');
{
  const log = [...baseLog(), hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }])];
  const result = foldSurface(log, []);
  check('image stays on the tool result', history(log, result), ['0:system[text]', '1:user[text]', '2:assistant[tool-call]', '3:tool[text+image]']);
}

console.log('\n8) malformed payloads fail loudly instead of producing a different history');
{
  const bad = [
    ['empty targets', { targets: [] }],
    ['missing userSeq', { targets: [{ targetSeq: 3 }] }],
    ['targetSeq equals userSeq', { targets: [{ targetSeq: 3, userSeq: 3 }] }],
    ['extra field', { targets: [{ targetSeq: 3, userSeq: 1, extra: true }] }]
  ];
  for (const [label, data] of bad) {
    let threw = false;
    try { fold([...baseLog(), event(4, IMAGE_HOIST_TYPE, data)]); } catch { threw = true; }
    check(`rejects ${label}`, threw, true);
  }
}

console.log('\n9) a tool result with no image is left alone');
{
  const log = [
    event(0, 'system/message', { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } }, { surfaceOp: 'append' }),
    event(1, 'user/message', { content: [{ type: 'text', text: 'run it' }], role: 'user' }, { surfaceOp: 'append' }),
    event(2, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } }, { surfaceOp: 'append' }),
    event(3, 'tool/result', { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'plain output' }] } }, { surfaceOp: 'append' }),
    hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }])
  ];
  check('history unchanged', history(log, fold(log)), ['0:system[text]', '1:user[text]', '2:assistant[tool-call]', '3:tool[text]']);
}

console.log('\n8) the projection declares its records ignorable');
{
  // The marker is what lets a reader without this plugin skip the rows instead of refusing the
  // whole log, so it is part of the written contract rather than of the fold.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  check('the append carries the marker', /append\(IMAGE_HOIST_TYPE, \{ targets \}, \{ ignorable: true \}\)/.test(source), true);
  check('the fixture matches the append', hoistEvent(4, [{ targetSeq: 3, userSeq: 1 }]).ignorable, true);
}

console.log('\n10) the already-hoisted set is membership, not a sequence watermark');
{
  // A compaction splice reorders the surface, so a never-hoisted tool result can sit
  // *below* an already-hoisted one in sequence value. A monotonic watermark would skip
  // it forever and leave its image in function_call_output, where a route that cannot
  // read tool-result image arrays bills the base64 as text (measured: 391,800 tokens
  // for two such images against 3,062 for five carried on user messages).
  const moved = hoistedSeqs([
    hoistEvent(90, [{ targetSeq: 40, userSeq: 10 }]),
    hoistEvent(91, [{ targetSeq: 45, userSeq: 12 }]),
  ]);
  check('records every moved source sequence', [...moved].sort((a, b) => a - b), [40, 45]);
  check('a lower never-moved sequence is still pending', moved.has(42), false);
  check('a moved sequence is not pending', moved.has(45), true);
}

console.log('\n11) several hoisted images accumulate on one carrier');
{
  // Every image-bearing tool result between two user turns belongs to the earlier turn, so one
  // carrier legitimately receives several images. The fold hands the projection the messages from
  // *before* the event, so re-reading the carrier there would overwrite each earlier image with
  // the next one and silently drop all but the last.
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'go' }], role: 'user' }, { surfaceOp: 'append' }),
    event(1, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_image', arguments: '{}' }] } }, { surfaceOp: 'append' }),
    event(2, 'tool/result', { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }, IMG(1)] } }, { surfaceOp: 'append' }),
    event(3, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read_image', arguments: '{}' }] } }, { surfaceOp: 'append' }),
    event(4, 'tool/result', { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'b' }, IMG(2), IMG(3)] } }, { surfaceOp: 'append' }),
    hoistEvent(5, [{ targetSeq: 2, userSeq: 0 }, { targetSeq: 4, userSeq: 0 }]),
  ];
  const fold = (l) => foldSurface(l, [imageHoistProjection]);
  const result = fold(log);
  const carrier = deriveEventMessage(log[0], result.projectedMessages);
  const ids = carrier.content.filter((block) => block.type === 'image').map((block) => block.attachment.attachmentId.slice(-4));
  check('every image reaches the carrier', ids, ['0001', '0002', '0003']);
  check('the tool results keep their text', history(log, result), ['0:user[text+image+image+image]', '1:assistant[tool-call]', '2:tool[text]', '3:assistant[tool-call]', '4:tool[text]']);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);