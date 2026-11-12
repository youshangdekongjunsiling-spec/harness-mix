const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSession, create, projectEvent } = require('../src/main/adapters/claude');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol } = require('../src/main/native/protocol');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out');
}

class FakeQuery {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.items.push(value);
  }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
  async interrupt() { return { still_queued: [] }; }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

async function adapterContract() {
  assert.equal(projectEvent({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' }).at(-1).stopReason, 'completed');
  assert.equal(projectEvent({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'background_requested' }).at(-1).stopReason, 'background_requested');
  assert.equal(projectEvent({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'tool_deferred' }).at(-1).stopReason, 'completed',
    'ordinary successful SDK terminal reasons still produce a final Host answer');
  const query = new FakeQuery();
  let options;
  const events = [];
  const sdk = { query(args) { options = args.options; return query; } };
  const session = spawnSession(sdk, { cwd: process.cwd(), emit: event => events.push(event) });
  const adapter = create();

  // A task edge alone must not manufacture a model turn.
  query.push({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'done', output_file: 'unused', session_id: 's', uuid: 'n1' });
  await until(() => session.state.pendingWakeSource === 'system');
  assert.equal(events.some(event => event.kind === 'native-turn-start'), false);

  // Cron and task-delivery hooks are the authoritative pre-turn signal.
  await options.hooks.UserPromptSubmit[0].hooks[0]({ source: 'schedule_wakeup' });
  await options.hooks.UserPromptSubmit[0].hooks[0]({ source: 'schedule_wakeup' });
  assert.equal(events.filter(event => event.kind === 'native-turn-start').length, 1, 'duplicate wake signals are idempotent');
  query.push({ type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'cron ran' }] }, session_id: 's', uuid: 'a1' });
  query.push({ type: 'result', subtype: 'success', is_error: false, result: 'cron ran', terminal_reason: 'completed', session_id: 's', uuid: 'r1' });
  await until(() => events.some(event => event.kind === 'completed'));
  assert.equal(events.filter(event => event.kind === 'native-turn-start').length, 1, 'assistant fallback does not duplicate hook start');

  // Some SDK/CLI versions may omit the hook source. The first conversational
  // frame still starts one autonomous turn; a bare result never does.
  query.push({ type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'task resumed' }] }, session_id: 's', uuid: 'a2' });
  query.push({ type: 'result', subtype: 'success', is_error: false, result: 'task resumed', terminal_reason: 'completed', session_id: 's', uuid: 'r2' });
  await until(() => events.filter(event => event.kind === 'completed').length === 2);
  assert.equal(events.filter(event => event.kind === 'native-turn-start').length, 2);
  query.push({ type: 'result', subtype: 'success', is_error: false, result: '', terminal_reason: 'completed', session_id: 's', uuid: 'late' });
  await sleep(20);
  assert.equal(events.filter(event => event.kind === 'native-turn-start').length, 2, 'orphan/late result cannot resurrect a turn');

  query.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'replay' }] }, session_id: 's', uuid: 'u-replay' });
  query.push({ type: 'assistant', parent_tool_use_id: 'parent-task', message: { id: 'sub', content: [{ type: 'text', text: 'subagent frame' }] }, session_id: 's', uuid: 'sub' });
  await sleep(20);
  assert.equal(events.filter(event => event.kind === 'native-turn-start').length, 2,
    'user replay and subagent frames do not create a main Host turn');

  // Permission can be the first callback of an autonomous turn.
  const permission = options.canUseTool('Bash', { command: 'echo safe' }, {});
  await until(() => events.some(event => event.kind === 'approval'));
  assert.equal(events.filter(event => event.kind === 'native-turn-start').length, 3);
  const approval = events.findLast(event => event.kind === 'approval');
  await adapter.respond(session, approval.requestId, { optionId: 'deny' });
  assert.equal((await permission).behavior, 'deny');
  query.push({ type: 'result', subtype: 'success', is_error: false, result: 'denied', terminal_reason: 'completed', session_id: 's', uuid: 'r3' });
  await until(() => events.filter(event => event.kind === 'completed').length === 4);

  // An unexpected process EOF during an autonomous turn settles it as failure.
  await options.hooks.UserPromptSubmit[0].hooks[0]({ source: 'schedule_wakeup' });
  query.close();
  await until(() => events.some(event => event.kind === 'error' && /完成前结束/.test(event.message)));
  const startsBeforeCancel = events.filter(event => event.kind === 'native-turn-start').length;
  await adapter.cancel(session);
  await options.hooks.UserPromptSubmit[0].hooks[0]({ source: 'schedule_wakeup' });
  const deniedAfterCancel = await options.canUseTool('Bash', { command: 'late' }, {});
  assert.equal(deniedAfterCancel.behavior, 'deny');
  assert.equal(events.filter(event => event.kind === 'native-turn-start').length, startsBeforeCancel,
    'a cancelled/closed SDK session cannot resurrect a Host turn');
}

async function runtimeContract() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-claude-wakeup-'));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  const runtime = new HostRuntime({ dataDirectory: directory });
  await runtime.store.load();
  const protocolEvents = [];
  const protocol = new NativeProtocol(runtime, event => protocolEvents.push(event));
  let emit;
  let approvalResponse;
  let wakeBeforeSendReturns = false;
  const adapter = {
    manifest: { id: 'claude-wakeup-test', name: 'Claude Wake Test', capabilities: {} },
    async open(context) { emit = context.emit; return { marker: 'original-claude-session' }; },
    async send() {
      emit({ kind: 'text-delta', text: 'initial' });
      emit({ kind: 'completed', finalAnswer: true });
      if (wakeBeforeSendReturns) emit({ kind: 'native-turn-start', source: 'system' });
    },
    async respond(session, requestId, response) { approvalResponse = { marker: session.marker, requestId, response }; },
    async cancel() {},
    async close() {},
  };
  runtime.adapters.set(adapter.manifest.id, adapter);
  runtime.status[adapter.manifest.id] = { available: true };
  const thread = await runtime.createThread({ harnessId: adapter.manifest.id, cwd: workspace });
  try {
    await runtime.send(thread.id, 'start');
    await until(() => thread.status === 'ready' && !thread.reviewPending);
    const originalMessages = thread.messages.length;

    const protocolStart = protocolEvents.length;
    emit({ kind: 'native-turn-start', source: 'system' });
    emit({ kind: 'native-turn-start', source: 'system' });
    assert.equal(thread.status, 'working');
    assert.equal(thread.messages.length, originalMessages + 1, 'duplicate native starts create one Host turn');
    const automatic = thread.messages.at(-1);
    assert.equal(automatic.role, 'assistant');
    assert.equal(automatic.coreItems.some(item => item.type === 'user_message'), false, 'native wakeup does not invent user input');
    await assert.rejects(runtime.send(thread.id, 'race'), /正在执行/);

    emit({ kind: 'approval', requestId: 'auto-approval', method: 'confirm', title: 'Allow?' });
    assert.equal(thread.currentTurn.status, 'waiting_interaction');
    const approvalRequest = protocolEvents.findLast(event => event.method === 'item/commandExecution/requestApproval');
    assert.ok(approvalRequest?.id, 'Desktop receives an approval request for the automatic turn');
    assert.equal(await protocol.respond({ id: approvalRequest.id, result: { decision: 'accept' } }), true);
    assert.deepEqual(approvalResponse, { marker: 'original-claude-session', requestId: 'auto-approval', response: { confirmed: true } },
      'Desktop approval is routed back to the original native session');
    emit({ kind: 'text-delta', text: 'automatic continuation' });
    emit({ kind: 'completed', finalAnswer: true, stopReason: 'completed' });
    await until(() => thread.status === 'ready' && !thread.reviewPending);
    assert.equal(thread.messages.at(-1).text, 'automatic continuation');
    assert.equal(thread.messages.at(-1).coreTurn.status, 'completed');
    assert.equal(thread.reviewPending, false, 'automatic turns do not wedge review settlement');
    const projected = protocolEvents.slice(protocolStart);
    const startedIndex = projected.findIndex(event => event.method === 'turn/started' && event.params.threadId === thread.id);
    const activeIndex = projected.findIndex(event => event.method === 'thread/status/changed' && event.params.threadId === thread.id && event.params.status.type === 'active');
    const deltaIndex = projected.findIndex(event => event.method === 'item/agentMessage/delta' && event.params.delta === 'automatic continuation');
    const itemCompletedIndex = projected.findIndex(event => event.method === 'item/completed' && event.params.item.type === 'agentMessage');
    const turnCompletedIndex = projected.findIndex(event => event.method === 'turn/completed' && event.params.threadId === thread.id);
    const idleIndex = projected.findIndex(event => event.method === 'thread/status/changed' && event.params.threadId === thread.id && event.params.status.type === 'idle');
    assert.ok(startedIndex >= 0 && activeIndex > startedIndex, 'Desktop sees turn start followed by active status');
    assert.ok(deltaIndex > activeIndex && itemCompletedIndex > deltaIndex, 'assistant output streams and completes in Desktop');
    assert.ok(turnCompletedIndex > itemCompletedIndex && idleIndex > turnCompletedIndex, 'Desktop sees turn completion followed by idle');

    // A native wakeup can race the old send Promise's final microtask. The old
    // send lock must clear without disturbing the autonomous Core turn.
    wakeBeforeSendReturns = true;
    await runtime.send(thread.id, 'start and immediately wake');
    wakeBeforeSendReturns = false;
    assert.equal(runtime.sending.has(thread.id), false);
    assert.equal(thread.status, 'working');
    await assert.rejects(runtime.send(thread.id, 'must wait'), /正在执行/);
    emit({ kind: 'completed', finalAnswer: true, stopReason: 'completed' });
    await until(() => thread.status === 'ready' && !thread.reviewPending);
    assert.equal(thread.reviewPending, false);

    emit({ kind: 'native-turn-start', source: 'schedule_wakeup' });
    emit({ kind: 'error', message: 'scheduled failure' });
    await until(() => thread.status === 'error');
    assert.equal(thread.messages.at(-1).coreTurn.status, 'error');

    emit({ kind: 'native-turn-start', source: 'system' });
    await runtime.cancel(thread.id);
    await until(() => thread.status === 'ready');
    assert.equal(thread.messages.at(-1).coreTurn.status, 'cancelled');
  } finally {
    protocol.close();
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

(async () => {
  await adapterContract();
  await runtimeContract();
  console.log('claude-background-wakeup: task and cron wakeups, approvals, races, failures, cancellation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
