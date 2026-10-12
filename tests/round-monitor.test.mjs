// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../Response Monitor.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end);
  assert.ok(a >= 0 && b > a, 'section markers must exist');
  return source.slice(a, b);
}
const parseSource = section('  // ---------- 内容有效性深度探测 ----------', '  // ---------- 运行环境 ----------');
const detectSource = section('  // ---------- 一轮生成侦测 ----------', '  // --- 全局错误兜底 ---');
const analyze = new Function(parseSource + '\nreturn analyzeResponseBody;')();
const factory = new Function('window', 'ctx', 'S', 'unlockOnce', 'triggerFailAlert',
  'triggerSuccessAlert', 'analyzeResponseBody', 'isBadCT', 'console', 'setTimeout', 'clearTimeout',
  detectSource + '\nreturn { arm };');
const asSse = text => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';

function setup(initial = 'Earlier swipe') {
  const handlers = new Map(), pending = [], alerts = [], logs = [], timers = new Map();
  let nextTimer = 0;
  const events = {
    on(key, cb) { handlers.set(key, [...(handlers.get(key) ?? []), cb]); },
    emit(key, ...args) { (handlers.get(key) ?? []).forEach(cb => cb(...args)); },
  };
  const ctx = {
    chatId: 'test-chat',
    chat: [{ mes: initial, swipe_id: 0, gen_started: 'old', is_user: false }],
    eventSource: events,
    eventTypes: {
      GENERATION_STARTED: 'start', GENERATION_ENDED: 'end',
      GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'changed',
    },
  };
  const win = { fetch: async () => ({
    ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    clone: () => ({ text: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }),
  }) };
  const monitor = factory(win, ctx,
    { debug: true, alertOnError: true, alertOnEmpty: true, alertOnSuccess: true },
    () => {}, () => alerts.push('empty/error'), () => alerts.push('success'),
    analyze, () => false, { info: (...a) => logs.push(a) },
    (fn, ms) => { const n = ++nextTimer; timers.set(n, { fn, ms }); return n; },
    id => timers.delete(id));

  const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    for (const [id, timer] of [...timers]) {
      if (timer.ms <= 10) { timers.delete(id); timer.fn(); }
    }
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };
  return {
    ctx, events, alerts, logs,
    async start(type, signal) {
      events.emit('start', type, {}, false);
      monitor.arm();
      await win.fetch('/api/openai/chat/completions', { method: 'POST', signal });
    },
    async respond(text) {
      assert.ok(pending.length);
      pending.shift().resolve(asSse(text));
      await flush();
    },
    async failRead(name = 'AbortError') {
      assert.ok(pending.length);
      const error = new Error('Cloned stream could not be read');
      error.name = name;
      pending.shift().reject(error);
      await flush();
    },
    async end(text, swipe = 1) {
      ctx.chat.at(-1).mes = text;
      ctx.chat.at(-1).swipe_id = swipe;
      ctx.chat.at(-1).gen_started = 'new';
      events.emit('end');
      await flush();
    },
    flush,
  };
}

test('network text but an empty final swipe is a failure', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.respond('text on the wire');
  assert.deepEqual(rig.alerts, []);
  await rig.end('');
  assert.deepEqual(rig.alerts, ['empty/error']);
  assert.equal(rig.logs[0][1].rendered, 'rendered-reply-empty');
});

test('a completed new swipe succeeds', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.respond('New answer');
  await rig.end('New answer');
  assert.deepEqual(rig.alerts, ['success']);
});

test('unchanged previous text is not a successful continuation', async () => {
  const rig = setup('Existing');
  await rig.start('continue');
  await rig.respond('ignored');
  await rig.end('Existing', 0);
  assert.deepEqual(rig.alerts, ['empty/error']);
});

test('continuation with new visible text succeeds', async () => {
  const rig = setup('Existing');
  await rig.start('continue');
  await rig.respond(' appended');
  await rig.end('Existing appended', 0);
  assert.deepEqual(rig.alerts, ['success']);
});

test('manual stop suppresses success and failure alerts', async () => {
  const rig = setup();
  await rig.start('normal');
  await rig.respond('Something');
  rig.events.emit('end');
  rig.events.emit('stop');
  await rig.flush();
  assert.deepEqual(rig.alerts, []);
});

test('earlier request cannot mark a later request successful', async () => {
  const rig = setup();
  await rig.start('normal');
  await rig.start('normal');
  await rig.respond('old result');
  assert.deepEqual(rig.alerts, []);
  await rig.respond('new result');
  rig.ctx.chat.push({ mes: 'new result', gen_started: 'new', is_user: false });
  rig.events.emit('end');
  await rig.flush();
  assert.deepEqual(rig.alerts, ['success']);
});


test('network-empty response waits for the final UI message before deciding', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.respond('');
  assert.deepEqual(rig.alerts, [], 'no early empty alert on network-only verdict');
  await rig.end('Finally generated text');
  assert.deepEqual(rig.alerts, ['success']);
  assert.equal(rig.logs[0][1].hasNetworkText, false);
  assert.equal(rig.logs[0][1].hasFinalText, true);
  assert.equal(rig.logs[0][1].rendered, 'new-swipe-text');
});

test('network-empty and final message empty is a failure once', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.respond('');
  assert.deepEqual(rig.alerts, []);
  await rig.end('');
  assert.deepEqual(rig.alerts, ['empty/error']);
  assert.equal(rig.logs[0][1].hasFinalText, false);
});

test('manual stop after network-empty completion emits no false empty alert', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.respond('');
  rig.events.emit('stop');
  rig.events.emit('end');
  await rig.flush();
  assert.deepEqual(rig.alerts, []);
});

test('aborted clone reader still reports success when final Swipe is valid', async () => {
  const rig = setup();
  const signal = { aborted: false };
  await rig.start('swipe', signal);
  signal.aborted = true; // automated retry may cancel the transport after data was received
  await rig.failRead('AbortError');
  assert.deepEqual(rig.alerts, [], 'reader failure alone must not be considered a stop');
  await rig.end('Valid new swipe');
  assert.deepEqual(rig.alerts, ['success']);
  assert.equal(rig.logs[0][1].network, 'stream-read-error');
  assert.equal(rig.logs[0][1].monitorErrorName, 'AbortError');
  assert.equal(rig.logs[0][1].signalAbortedAtReadError, true);
  assert.equal(rig.logs[0][1].hasFinalText, true);
});

test('cloned reader failure with empty final Swipe is an empty reply', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.failRead('AbortError');
  await rig.end('');
  assert.deepEqual(rig.alerts, ['empty/error']);
  assert.equal(rig.logs[0][1].rendered, 'rendered-reply-empty');
});

test('explicit manual stop still suppresses alerts after cloned reader failure', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.failRead('AbortError');
  rig.events.emit('stop');
  await rig.end('Partial');
  assert.deepEqual(rig.alerts, []);
  assert.equal(rig.logs[0][1].outcome, 'aborted');
});

test('other clone-reading errors can recover from successful final message', async () => {
  const rig = setup();
  await rig.start('swipe');
  await rig.failRead('TypeError');
  await rig.end('Recovered');
  assert.deepEqual(rig.alerts, ['success']);
  assert.equal(rig.logs[0][1].monitorErrorName, 'TypeError');
});
