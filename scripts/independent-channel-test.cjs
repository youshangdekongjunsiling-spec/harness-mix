const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { HostRuntime } = require('../src/main/host/runtime');
const { NativeProtocol } = require('../src/main/native/protocol');
const wait = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('Integration condition timed out'); };

(async () => {
  const root = path.resolve('output/independent-channel', String(Date.now()));
  await fs.mkdir(root, { recursive: true });
  await esbuild.build({ entryPoints: ['src/native-ui/renderer-extension/src/independent-sidecar-client.ts'], bundle: true,
    alias: { '@harnessmix/shared-contracts': path.resolve('src/native-ui/shared-contracts/src/index.ts') },
    platform: 'node', format: 'cjs', outfile: path.join(root, 'client.cjs') });
  const { createIndependentSidecarClient } = require(path.join(root, 'client.cjs'));
  const runtime = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await runtime.store.load();
  let emit; const answers = [], sent = [], events = []; let officialCalls = 0;
  runtime.adapters.set('pi', {
    manifest: { id: 'pi', name: 'Fixture Harness', capabilities: { streaming: true, models: true, approvals: true, questions: true, resume: true } },
    async open(input) { emit = input.emit; return {}; },
    async describe() { return { models: [{ id: 'fixture', name: 'Fixture', provider: 'test' }], thinkingLevels: [], permissionModes: [] }; },
    async send(session, text) { sent.push(text); }, async cancel() {}, async close() {},
    async respond(session, id, result) { answers.push({ id, result }); },
  });
  runtime.status.pi = { available: true };
  let client;
  const protocol = new NativeProtocol(runtime, frame => { events.push(frame); client?.receive(JSON.stringify(frame)); }, async () => { officialCalls++; throw Error('Official route must remain untouched'); });
  const connect = () => createIndependentSidecarClient(text => {
    const frame = JSON.parse(text);
    void protocol.request(frame.method, frame.params).then(result => {
      client.receive(JSON.stringify(result === undefined ? { id: frame.id, error: { message: 'Unowned request rejected' } } : { id: frame.id, result }));
    }, error => client.receive(JSON.stringify({ id: frame.id, error: { message: error.message } })));
  });
  client = connect();
  try {
    const modelRef = Buffer.from(JSON.stringify({ id: 'fixture', provider: 'test' })).toString('base64url');
    const route = 'harnessmix/plugin-v1@' + Buffer.from(JSON.stringify({ harnessId: 'pi', model: { id: modelRef } })).toString('hex');
    const created = await client.request('thread/start', { model: route, cwd: root });
    const threadId = created.thread.id;
    const started = await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'integration input' }] });
    assert.ok(started.turn.id); assert.deepEqual(sent, ['integration input']);
    emit({ kind: 'text-delta', text: 'real protocol stream' });
    emit({ kind: 'approval', requestId: 'permission', method: 'confirm', title: 'Allow fixture?' });
    await wait(() => client.pendingApprovals().length === 1);
    await client.respond(client.pendingApprovals()[0].id, { decision: 'accept' });
    assert.deepEqual(answers[0], { id: 'permission', result: { confirmed: true } });
    emit({ kind: 'approval', requestId: 'question', method: 'input', title: 'Pick', questions: [
      { id: 'q1', question: 'Select options', multiple: true, options: [{ label: 'A' }, { label: 'B' }] },
    ] });
    await wait(() => client.pendingApprovals().length === 1);
    client.dispose(); client = connect();
    await client.request('thread/read', { threadId });
    await wait(() => client.pendingApprovals().length === 1);
    const question = client.pendingApprovals()[0]; assert.equal(question.params.questions[0].harnessmixMultiple, true);
    await client.respond(question.id, { answers: { q1: { answers: ['A', 'B'] } } });
    assert.deepEqual(answers[1].result, { answers: { 'Select options': 'A, B' } });
    emit({ kind: 'completed', finalAnswer: true });
    await wait(() => !runtime.execution.isRunning(threadId));
    const restored = await client.request('thread/resume', { threadId });
    assert.ok(restored.thread.turns.some(t => t.items.some(i => i.type === 'userMessage' && i.content.some(c => c.text === 'integration input'))));
    assert.ok(restored.thread.turns.some(t => t.items.some(i => i.type === 'agentMessage' && i.text === 'real protocol stream')));
    assert.ok(events.some(e => e.method === 'item/agentMessage/delta'));
    const next = await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'second input' }] });
    await wait(() => sent.includes('second input'));
    await client.request('turn/steer', { threadId, expectedTurnId: next.turn.id, input: [{ type: 'text', text: 'correction' }] });
    await wait(() => sent.includes('correction'));
    assert.equal(sent.at(-1), 'correction');
    await client.request('turn/interrupt', { threadId });
    await wait(() => !runtime.execution.isRunning(threadId));
    await assert.rejects(client.request('turn/start', { threadId: 'official-thread', input: [] }), /Unowned request/);
    assert.equal(officialCalls, 0);
    console.log('independent channel: new thread, streaming, approval ACK/reconnect, multi-choice, steering/cancel, persisted history and official-route isolation passed');
  } finally { client.dispose(); protocol.close(); await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
