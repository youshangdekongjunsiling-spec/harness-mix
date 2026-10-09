const assert = require('node:assert/strict');
const path = require('node:path');
const { HostRuntime } = require('../src/main/host/runtime');
const { detachForkedNativeHistorySync } = require('../src/main/host/claude-history-sync');
const { NativeProtocol } = require('../src/main/native/protocol');
const wait = async fn => { for (let n = 0; n < 400; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Timed out'); };

(async () => {
  const root = path.resolve('output/rollback-test', String(Date.now()));
  await require('node:fs/promises').mkdir(root, { recursive: true });
  const runtime = new HostRuntime({ dataDirectory: path.join(root, 'data') });
  await runtime.store.load();
  let forks = 0;
  const adapter = {
    manifest: { id: 'claude', name: 'Claude', capabilities: { fork: true, forkFromMessage: true } },
    async open({ thread }) { return { nativeSessionId: thread.nativeSessionId }; },
    async close() {}, async describe() { return { models: [] }; },
    async send(_session, text, hooks) { hooks.emit({ kind: 'text-delta', text }); hooks.emit({ kind: 'completed', finalAnswer: true }); },
    async fork(_thread, { message }) { assert.equal(message.text, 'kept'); forks++; return { session: { nativeSessionId: 'forked-native', nativeSessionFile: 'forked-native.jsonl' } }; },
  };
  runtime.adapters.set('claude', adapter); runtime.status.claude = { available: true };
  const protocolEvents = [];
  const bridge = new NativeProtocol(runtime, event => protocolEvents.push(event));
  try {
    const { thread } = await bridge.request('thread/start', { cwd: root, model: 'harnessmix/claude-code-native' });
    for (const text of ['kept', 'removed']) {
      await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
      await wait(() => !runtime.execution.isRunning(thread.id) && !runtime.threads[0].reviewPending);
    }
    const originalNativeSessionId = runtime.threads[0].nativeSessionId;
    const originalNativeSessionFile = path.join(root, originalNativeSessionId + '.jsonl');
    runtime.threads[0].nativeSessionFile = originalNativeSessionFile;
    runtime.threads[0].nativeHistorySnapshot = { version: 1, source: 'claude', nativeSessionId: originalNativeSessionId };
    runtime.threads[0].nativeHistorySync = { enabled: true, paused: false, status: 'synced',
      sourceFile: originalNativeSessionFile, cursor: { targetFingerprint: 'old-target' } };
    await assert.rejects(bridge.request('thread/rollback', { threadId: thread.id, numTurns: 3 }), /回退轮数/);
    const rollback = await bridge.request('thread/rollback', { threadId: thread.id, numTurns: 1 });
    assert.equal(forks, 1);
    assert.equal(rollback.thread.turns.length, 1);
    assert.equal(runtime.threads[0].nativeSessionId, 'forked-native');
    assert.equal(runtime.threads[0].nativeSessionFile, 'forked-native.jsonl');
    assert.equal(runtime.threads[0].messages.length, 2);
    assert.deepEqual(runtime.threads[0].rewindHistory[0], { nativeSessionId: originalNativeSessionId,
      nativeSessionFile: originalNativeSessionFile, at: runtime.threads[0].rewindHistory[0].at, numTurns: 1 });
    assert.equal(typeof runtime.threads[0].rewindHistory[0].at, 'number');
    assert.deepEqual(runtime.threads[0].nativeHistorySync, { enabled: false, paused: false, status: 'detached',
      reason: 'native-session-forked', checkedAt: runtime.threads[0].nativeHistorySync.checkedAt });
    assert.equal(runtime.threads[0].nativeHistorySnapshot, undefined);
    assert(protocolEvents.some(event => event.method === 'harnessmix/thread/nativeHistorySync/updated'
      && event.params.threadId === thread.id && event.params.status === 'detached'
      && event.params.reason === 'native-session-forked'));
    assert.ok(!rollback.thread.turns.flatMap(t => t.items).some(i => i.type === 'agentMessage' && i.text === 'removed'));
    const empty = await bridge.request('thread/rollback', { threadId: thread.id, numTurns: 1 });
    assert.equal(empty.thread.turns.length, 0);
    assert.notEqual(runtime.threads[0].nativeSessionId, 'forked-native');
    await bridge.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'replacement' }] });
    await wait(() => !runtime.execution.isRunning(thread.id) && !runtime.threads[0].reviewPending);
    assert.equal(bridge.projectThread(runtime.threads[0]).turns.length, 1);
    const stored = await runtime.store.load();
    assert.equal(stored[0].coreState.turns.length, 1);
    assert.equal(stored[0].rewindHistory.length, 2);
    const index = JSON.parse(await require('node:fs/promises').readFile(runtime.store.indexFile, 'utf8'));
    assert.deepEqual(index.threads[0].rewindHistory, stored[0].rewindHistory,
      'compact rollback lineage remains available without hydrating the thread record');

    const unrelated = { harnessId: 'claude', nativeSessionId: 'new-session', rewindHistory: [],
      nativeHistorySnapshot: { source: 'claude', nativeSessionId: 'old-session' },
      nativeHistorySync: { enabled: true, sourceFile: path.join(root, 'old-session.jsonl') } };
    assert.equal(detachForkedNativeHistorySync(unrelated), false,
      'an identity mismatch without verified rewind lineage is left untouched');
    assert.equal(unrelated.nativeHistorySync.enabled, true);

    const migrationRoot = path.join(root, 'migration');
    const originalId = '11111111-1111-4111-8111-111111111111';
    const currentId = '22222222-2222-4222-8222-222222222222';
    const legacyRuntime = new HostRuntime({ dataDirectory: migrationRoot });
    legacyRuntime.threads = [{ id: 'legacy-fork', harnessId: 'claude', title: 'Legacy fork', cwd: root,
      nativeSessionId: currentId, nativeSessionFile: path.join(root, originalId + '.jsonl'),
      status: 'ready', connectionStatus: 'ready', createdAt: 1, updatedAt: 2,
      messages: [], tools: [], pendingApprovals: [], options: {},
      rewindHistory: [{ nativeSessionId: originalId, at: 2, numTurns: 1 }],
      nativeHistorySnapshot: { version: 1, source: 'claude', nativeSessionId: originalId },
      nativeHistorySync: { enabled: true, paused: false, status: 'synced',
        sourceFile: path.join(root, originalId + '.jsonl'), cursor: { targetFingerprint: 'legacy' } } }];
    await legacyRuntime.store.save(legacyRuntime.threads);
    await legacyRuntime.close();
    const legacyIndex = JSON.parse(await require('node:fs/promises').readFile(legacyRuntime.store.indexFile, 'utf8'));
    delete legacyIndex.threads[0].rewindHistory;
    await require('node:fs/promises').writeFile(legacyRuntime.store.indexFile, JSON.stringify(legacyIndex));
    const restarted = new HostRuntime({ dataDirectory: migrationRoot });
    await restarted.initialize();
    const reconciled = restarted.threads.find(value => value.id === 'legacy-fork');
    assert.equal(reconciled._storageStub, undefined, 'a suspicious legacy stub is hydrated before lineage verification');
    assert.equal(reconciled.nativeHistorySnapshot, undefined);
    assert.equal(reconciled.nativeSessionFile, undefined);
    assert.deepEqual(reconciled.nativeHistorySync, { enabled: false, paused: false, status: 'detached',
      reason: 'native-session-forked', checkedAt: reconciled.nativeHistorySync.checkedAt });
    const reloaded = (await restarted.store.load()).find(value => value.id === 'legacy-fork');
    assert.equal(reloaded.nativeHistorySnapshot, undefined);
    assert.equal(reloaded.nativeHistorySync.reason, 'native-session-forked');
    assert.equal(reloaded.rewindHistory[0].nativeSessionId, originalId);
    assert.equal(reloaded.rewindHistory[0].nativeSessionFile, path.join(root, originalId + '.jsonl'));
    await restarted.close();
    console.log('PASS: native fork boundary, empty-session rewind, resend, persistence and invalid counts');
  } finally { bridge.close(); await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
