const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { create, spawnSession } = require('../src/main/adapters/claude');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol } = require('../src/main/native/protocol');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    const value = fn();
    if (value) return value;
    await sleep(10);
  }
  throw new Error('timed out');
}

class ControlledQuery {
  constructor(args, holdInterrupt = false) {
    this.options = args.options;
    this.input = args.prompt[Symbol.asyncIterator]();
    this.events = [];
    this.waiters = [];
    this.interruptCalls = 0;
    this.closeCalls = 0;
    this.interruptPromise = holdInterrupt ? new Promise(resolve => { this.releaseInterrupt = resolve; }) : Promise.resolve();
  }
  emit(event) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.events.push(event);
  }
  async interrupt() {
    this.interruptCalls += 1;
    await this.interruptPromise;
  }
  close() { this.closeCalls += 1; }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.events.length
        ? { value: this.events.shift(), done: false }
        : await new Promise(resolve => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-claude-steer-'));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  const runtime = new HostRuntime({ dataDirectory: path.join(directory, 'data') });
  await runtime.store.load();

  const queries = [];
  const opens = [];
  const sdk = {
    query(args) {
      const query = new ControlledQuery(args, queries.length === 0);
      queries.push(query);
      return query;
    },
  };
  const implementation = create();
  const adapter = {
    ...implementation,
    async open({ thread, emit }) {
      opens.push({ nativeSessionId: thread.nativeSessionId, restore: thread.restore });
      return spawnSession(sdk, {
        cwd: thread.cwd,
        resumeId: thread.restore ? thread.nativeSessionId : undefined,
        newSessionId: thread.restore ? undefined : thread.nativeSessionId,
        emit,
      });
    },
  };
  runtime.adapters.set('claude', adapter);
  runtime.status.claude = { available: true };
  const events = [];
  const bridge = new NativeProtocol(runtime, event => events.push(event), async method => {
    throw new Error(`unexpected official request: ${method}`);
  });

  try {
    const thread = await runtime.createThread({ harnessId: 'claude', cwd: workspace });
    const first = await bridge.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'first' }],
    });
    const oldQuery = await until(() => queries[0]);
    assert.equal((await oldQuery.input.next()).value.message.content[0].text, 'first');

    let releaseCollaboration;
    const collaborationGate = new Promise(resolve => { releaseCollaboration = resolve; });
    runtime.collaboration.cancelOwner = async () => collaborationGate;
    const steering = bridge.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: first.turn.id,
      clientUserMessageId: 'claude-steer-regression',
      input: [{ type: 'text', text: 'redirect' }],
    });
    await until(() => oldQuery.interruptCalls === 1);
    assert.equal(runtime.sessions.get(thread.id)?.state.closed, true,
      'native query is gated before slower collaboration cancellation settles');

    // cancel() must close the projection gate before interrupt() acknowledges.
    oldQuery.emit({ type: 'assistant', session_id: thread.nativeSessionId,
      message: { id: 'stale-assistant', content: [{ type: 'text', text: 'STALE_BEFORE_ACK' }] } });
    oldQuery.emit({ type: 'user', session_id: thread.nativeSessionId,
      message: { content: [{ type: 'tool_result', tool_use_id: 'stale-tool', content: 'stale', is_error: false }] } });
    const permission = await oldQuery.options.canUseTool('Bash', { command: 'stale' }, {});
    assert.equal(permission.behavior, 'deny', 'late permission requests are denied after cancellation begins');
    await sleep(20);
    assert.equal(events.some(event => JSON.stringify(event).includes('STALE_BEFORE_ACK')), false,
      'old assistant/tool events are gated while interrupt acknowledgement is pending');

    oldQuery.releaseInterrupt();
    releaseCollaboration();
    const steered = await steering;
    const newQuery = await until(() => queries[1]);
    assert.equal(oldQuery.closeCalls, 1, 'cancel force-closes the old SDK query');
    assert.equal(opens.length, 2, 'the replacement turn opens a fresh SDK query');
    assert.equal(opens[1].restore, true, 'the fresh query resumes the same native session');
    assert.equal(opens[1].nativeSessionId, opens[0].nativeSessionId);
    assert.equal((await newQuery.input.next()).value.message.content[0].text, 'redirect');
    assert.notEqual(steered.turnId, first.turn.id);

    // Even a misbehaving transport that produces buffered events after close cannot
    // settle or fail the replacement Host Turn.
    const eventCount = events.length;
    oldQuery.emit({ type: 'assistant', session_id: thread.nativeSessionId,
      message: { id: 'stale-after-close', content: [{ type: 'text', text: 'STALE_AFTER_CLOSE' }] } });
    oldQuery.emit({ type: 'result', session_id: thread.nativeSessionId, subtype: 'error_during_execution',
      is_error: true, result: 'Agent is already processing' });
    await sleep(30);
    assert.equal(events.length, eventCount, 'closed-query events are fully suppressed');
    assert.equal(runtime.execution.isRunning(thread.id), true, 'late old result cannot settle the replacement Turn');
    assert.equal(runtime.execution.lastTurn(thread.id).id, steered.turnId);
    assert.equal(thread.error, undefined, 'late old errors do not contaminate the replacement Turn');

    newQuery.emit({ type: 'assistant', session_id: thread.nativeSessionId,
      message: { id: 'fresh-assistant', content: [{ type: 'text', text: 'FRESH' }] } });
    newQuery.emit({ type: 'result', session_id: thread.nativeSessionId, subtype: 'success', is_error: false, result: 'FRESH' });
    await until(() => !runtime.execution.isRunning(thread.id) && !runtime.sending.has(thread.id));
    assert.equal(runtime.execution.lastTurn(thread.id).id, steered.turnId);
    assert.equal(runtime.execution.lastTurn(thread.id).status, 'completed');
    assert.ok(events.some(event => JSON.stringify(event).includes('FRESH')));

    console.log('claude-cancel-steer-test: cancelled query isolated; late events cannot poison replacement turn');
  } finally {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
