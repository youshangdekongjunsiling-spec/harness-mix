const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const { ClaudeHistorySync, branchChain, checkpointFingerprint, hashBytes, hashPrefix, parseCompleteJsonl }
  = require(path.join(packageRoot, 'src/main/host/claude-history-sync'));
const { CoreSession } = require(path.join(packageRoot, 'src/main/host/core-session'));
const { createClaudeHistorySyncOptions } = require(path.join(packageRoot, 'src/main/native/claude-sync-options'));

const row = (type, uuid, parentUuid, text) => ({ type, uuid, parentUuid, parent_tool_use_id: null,
  sessionId: 'fixture-session',
  timestamp: new Date(1_700_000_000_000 + Number(uuid.replace(/\D/g, '') || 0)).toISOString(),
  message: { role: type, content: [{ type: 'text', text }], ...(type === 'assistant' ? { stop_reason: 'end_turn' } : {}) } });
const encode = rows => Buffer.from(rows.map(value => JSON.stringify(value)).join('\n') + '\n');

function selectBranch(rows) {
  const withIds = rows.filter(value => typeof value?.uuid === 'string');
  const byId = new Map(withIds.map(value => [value.uuid, value]));
  const branch = [];
  const seen = new Set();
  let current = withIds.at(-1);
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    branch.unshift(current);
    current = byId.get(current.parentUuid ?? current.parent_uuid);
  }
  return branch;
}

function candidate(threadId, rows) {
  const messages = [];
  const users = rows.filter(value => value.type === 'user');
  for (const user of users) {
    const assistant = rows.find(value => value.type === 'assistant' && value.parentUuid === user.uuid);
    messages.push({ id: `claude-user-${user.uuid}`, role: 'user', text: user.message.content[0].text, at: Date.parse(user.timestamp) });
    messages.push({ id: `claude-history-${user.uuid}`, role: 'assistant', at: Date.parse(assistant?.timestamp ?? user.timestamp),
      endedAt: Date.parse(assistant?.timestamp ?? user.timestamp), items: assistant ? [{ kind: 'text',
        text: assistant.message.content[0].text, phase: 'final', at: Date.parse(assistant.timestamp) }] : [] });
  }
  const thread = { id: threadId, cwd: 'C:\\fixture', harnessId: 'claude', nativeSessionId: 'fixture-session',
    title: 'fixture', createdAt: 1, updatedAt: Date.now(), messages, tools: [], pendingApprovals: [] };
  const execution = new CoreSession();
  execution.threadCreated(thread);
  return { checkpoint: execution.checkpoint(thread), messages, updatedAt: thread.updatedAt };
}

class FakeRuntime {
  constructor(file, initial) {
    this.threadId = 'thread-1';
    this.thread = { id: this.threadId, cwd: 'C:\\fixture', harnessId: 'claude',
      nativeSessionId: 'fixture-session', title: 'fixture', createdAt: 1, updatedAt: 1,
      messages: [], tools: [], pendingApprovals: [] };
    this.source = { threadId: this.threadId, harnessId: 'claude', sourceFile: file, enabled: true,
      paused: false, status: 'synced', cursor: {} };
    this.target = initial;
    this.applyCount = 0;
    this.statuses = [];
    this.busy = false;
  }
  listClaudeHistorySyncSources() { return [{ ...this.source, cursor: { ...this.source.cursor } }]; }
  isClaudeHistorySyncBusy() { return this.busy; }
  prepareClaudeHistorySync() { return { thread: this.thread, checkpoint: this.target.checkpoint }; }
  async updateClaudeHistorySyncStatus(_id, patch) {
    this.source = { ...this.source, ...patch };
    if (patch.cursor) this.source.cursor = { ...patch.cursor };
    this.statuses.push(patch);
  }
  announceClaudeHistorySyncStatus() {}
  async commitClaudeHistorySync(_id, next, cursor) {
    const oldIds = this.target.checkpoint.turns.map(value => value.id);
    assert.deepEqual(next.checkpoint.turns.slice(0, oldIds.length).map(value => value.id), oldIds);
    this.target = next;
    this.source.cursor = { ...cursor, targetFingerprint: checkpointFingerprint(next.checkpoint) };
    this.source.status = 'synced';
    this.applyCount += 1;
  }
}

async function fixture(initialRows) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-claude-sync-'));
  const file = path.join(directory, 'session.jsonl');
  const bytes = encode(initialRows);
  await fs.writeFile(file, bytes);
  const branch = selectBranch(initialRows);
  const initial = candidate('thread-1', branch);
  const runtime = new FakeRuntime(file, initial);
  const stat = await fs.stat(file);
  runtime.source.cursor = { observedSize: stat.size, observedMtimeMs: stat.mtimeMs, appliedSize: bytes.length,
    sourcePrefixHash: hashBytes(bytes), branchCount: branchChain(branch).length,
    prefixHash: hashPrefix(branchChain(branch)), leafUuid: branch.at(-1)?.uuid,
    targetFingerprint: checkpointFingerprint(initial.checkpoint) };
  let reads = 0;
  const sync = new ClaudeHistorySync({ runtime, intervalMs: 60_000,
    readFile: async value => { reads += 1; return fs.readFile(value); },
    readSnapshot: async ({ rows }) => ({ branchRows: selectBranch(rows) }),
    applySnapshot: async ({ snapshot }) => candidate('thread-1', snapshot.branchRows) });
  sync.start();
  await sync.tick();
  return { directory, file, runtime, sync, reads: () => reads };
}

async function append(file, rows) { await fs.appendFile(file, encode(rows)); }

async function testAppendIdempotentPartialAndQueue() {
  const one = [row('user', 'u1', null, 'prompt 1'), row('assistant', 'a1', 'u1', 'answer 1')];
  const f = await fixture(one);
  assert.equal(f.reads(), 0, 'unchanged source must not be read');
  await fs.appendFile(f.file, JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }) + '\n');
  await f.sync.tick();
  assert.equal(f.runtime.applyCount, 0, 'non-branch rows must not rebuild target');
  await append(f.file, [row('user', 'u2', 'a1', 'prompt 2'), row('assistant', 'a2', 'u2', 'answer 2')]);
  await f.sync.tick();
  assert.equal(f.runtime.applyCount, 1, 'new branch turn must apply once');
  const reads = f.reads();
  await f.sync.tick();
  assert.equal(f.reads(), reads, 'idempotent poll must stop at stat metadata');
  await fs.appendFile(f.file, '{"type":"user","uuid":"u3"');
  await f.sync.tick();
  assert.equal(f.runtime.applyCount, 1, 'partial JSONL tail must wait');
  assert.equal(f.runtime.source.status, 'waiting');
  await fs.appendFile(f.file, ',"parentUuid":"a2","message":{"content":"prompt 3"}}\n');
  await f.sync.tick();
  assert.equal(f.runtime.applyCount, 2, 'completed tail becomes eligible on a later poll');
  await f.sync.stop();
  assert.equal(f.sync.timer, null);
  await fs.rm(f.directory, { recursive: true, force: true });
}

async function testRewriteBranchTruncateBusyAndHostConflict() {
  const base = [row('user', 'u1', null, 'prompt 1'), row('assistant', 'a1', 'u1', 'answer 1')];

  const rewrite = await fixture(base);
  const changed = encode([base[0], row('assistant', 'a1', 'u1', 'ANSWER 1')]);
  await fs.writeFile(rewrite.file, changed);
  rewrite.runtime.source.cursor.observedMtimeMs = -1;
  await rewrite.sync.tick();
  assert.equal(rewrite.runtime.source.reason, 'source-rewritten', 'same UUID with changed content must pause');
  await rewrite.sync.stop();

  const branch = await fixture(base);
  await append(branch.file, [row('user', 'b1', 'u1', 'alternate'), row('assistant', 'b2', 'b1', 'alternate answer')]);
  await branch.sync.tick();
  assert.equal(branch.runtime.source.reason, 'branch-changed');
  await branch.sync.stop();

  const truncated = await fixture(base);
  await fs.writeFile(truncated.file, encode([base[0]]));
  await truncated.sync.tick();
  assert.equal(truncated.runtime.source.reason, 'source-truncated');
  await truncated.sync.stop();

  const busy = await fixture(base);
  busy.runtime.busy = true;
  await append(busy.file, [row('user', 'u2', 'a1', 'prompt 2')]);
  const beforeBusyReads = busy.reads();
  await busy.sync.tick();
  assert.equal(busy.reads(), beforeBusyReads, 'busy Host must be checked before source read');
  assert.equal(busy.runtime.source.status, 'waiting');
  busy.runtime.busy = false;
  await append(busy.file, [row('assistant', 'a2', 'u2', 'answer 2')]);
  await busy.sync.tick();
  assert.equal(busy.runtime.applyCount, 1);
  await busy.sync.stop();

  const host = await fixture(base);
  host.runtime.target.checkpoint.items[0].content = 'local continuation/change';
  await append(host.file, [row('user', 'u2', 'a1', 'prompt 2')]);
  await host.sync.tick();
  assert.equal(host.runtime.source.reason, 'host-history-changed');
  assert.equal(host.runtime.applyCount, 0);
  await host.sync.stop();
  for (const value of [rewrite, branch, truncated, busy, host]) await fs.rm(value.directory, { recursive: true, force: true });
}

async function testFingerprintRoundTripAndStop() {
  const projected = candidate('thread-1', [row('user', 'u1', null, 'p'), row('assistant', 'a1', 'u1', 'a')]);
  const reloadedThread = { id: 'thread-1', cwd: 'C:\\fixture', harnessId: 'claude', nativeSessionId: 'fixture-session',
    title: 'fixture', messages: structuredClone(projected.messages), coreState: structuredClone(projected.checkpoint) };
  const execution = new CoreSession();
  execution.threadCreated(reloadedThread);
  assert.equal(checkpointFingerprint(execution.checkpoint(reloadedThread)), checkpointFingerprint(projected.checkpoint));
  const withDetachedUsage = structuredClone(projected.checkpoint);
  withDetachedUsage.items.push({ id: 'usage-thread-1', type: 'usage', turnId: null,
    status: 'completed', usage: { inputTokens: 1 } });
  assert.equal(checkpointFingerprint(withDetachedUsage), checkpointFingerprint(projected.checkpoint),
    'thread-level derived usage must not invalidate the history target fingerprint');
  withDetachedUsage.items[withDetachedUsage.items.length - 1].usage.inputTokens = 2;
  assert.equal(checkpointFingerprint(withDetachedUsage), checkpointFingerprint(projected.checkpoint),
    'updates to thread-level derived usage must not invalidate the history target fingerprint');
  for (const type of ['user_message', 'agent_message', 'tool_call', 'usage']) {
    const withTurnItem = structuredClone(projected.checkpoint);
    withTurnItem.items.push({ id: `changed-${type}`, type, turnId: withTurnItem.turns[0].id,
      status: 'completed' });
    assert.notEqual(checkpointFingerprint(withTurnItem), checkpointFingerprint(projected.checkpoint),
      `${type} attached to a turn must remain part of conflict detection`);
  }

  let stats = 0;
  const runtime = { listClaudeHistorySyncSources: () => [], announceClaudeHistorySyncStatus() {} };
  const sync = new ClaudeHistorySync({ runtime, intervalMs: 60_000, stat: async () => { stats += 1; },
    readSnapshot: async () => ({}), applySnapshot: async () => ({}) });
  sync.start();
  await sync.stop();
  await sync.tick();
  assert.equal(sync.timer, null);
  assert.equal(stats, 0, 'stopped synchronizer must not poll');
}

async function testProductionProjectionIsDeterministic() {
  const rows = [row('user', 'u1', null, 'prompt'), row('assistant', 'a1', 'u1', 'answer')];
  const options = createClaudeHistorySyncOptions();
  const target = { thread: { id: 'thread-1', cwd: 'C:\\fixture', harnessId: 'claude',
    nativeSessionId: 'fixture-session', title: 'fixture', createdAt: 1, updatedAt: 1,
    messages: [], tools: [], pendingApprovals: [], usage: {} }, checkpoint: {
      thread: { usage: { inputTokens: 1, contextWindow: 100 } }, items: [
      { id: 'usage-thread-1', type: 'usage', turnId: null, status: 'completed', usage: { inputTokens: 1 } },
    ] } };
  const snapshot = options.readSnapshot({ rows, target, completeBytes: encode(rows).length });
  const first = options.applySnapshot({ snapshot, target });
  const second = options.applySnapshot({ snapshot, target });
  assert.equal(checkpointFingerprint(first.checkpoint), checkpointFingerprint(second.checkpoint));
  assert.equal(first.nativeHistorySnapshot.sourceMessageCount, 2);
  assert.equal(first.checkpoint.turns.length, 1);
  assert.equal(first.checkpoint.items.filter(item => item.type === 'usage').length, 1,
    'source reprojection must retain detached Host usage');
  assert.deepEqual(first.checkpoint.thread.usage, target.checkpoint.thread.usage,
    'source reprojection must retain the current thread usage summary');
}

async function testCompactionBridgeAndFollowingAppend() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-claude-compact-sync-'));
  const file = path.join(directory, 'session.jsonl');
  const before = [row('user', 'cu1', null, 'before compact'), row('assistant', 'ca1', 'cu1', 'before answer')];
  await fs.writeFile(file, encode(before));
  const options = createClaudeHistorySyncOptions();
  const target = { thread: { id: 'thread-1', cwd: 'C:\\fixture', harnessId: 'claude',
    nativeSessionId: 'fixture-session', title: 'fixture', createdAt: 1, updatedAt: 1,
    messages: [], tools: [], pendingApprovals: [] } };
  const initialSnapshot = options.readSnapshot({ rows: before, target, completeBytes: encode(before).length });
  const initial = options.applySnapshot({ snapshot: initialSnapshot, target });
  const runtime = new FakeRuntime(file, initial);
  const stat = await fs.stat(file);
  const initialChain = branchChain(initialSnapshot.branchRows);
  runtime.source.cursor = { observedSize: stat.size, observedMtimeMs: stat.mtimeMs,
    appliedSize: encode(before).length, sourcePrefixHash: hashBytes(encode(before)),
    branchCount: initialChain.length, prefixHash: hashPrefix(initialChain),
    leafUuid: initialSnapshot.branchRows.at(-1).uuid, targetFingerprint: checkpointFingerprint(initial.checkpoint) };
  const sync = new ClaudeHistorySync({ runtime, intervalMs: 60_000, ...options });
  sync.start(); await sync.tick();

  const compactAppend = [
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-1', parentUuid: null,
      logicalParentUuid: 'ca1', sessionId: 'fixture-session', timestamp: '2026-10-08T11:01:00.000Z',
      compactMetadata: { preservedMessages: { anchorUuid: 'cu1', uuids: ['ca1'] } } },
    { type: 'user', uuid: 'summary-1', parentUuid: 'compact-1', sessionId: 'fixture-session',
      timestamp: '2026-10-08T11:01:01.000Z', isCompactSummary: true,
      message: { role: 'user', content: 'synthetic summary' } },
    { type: 'assistant', uuid: 'continued-1', parentUuid: 'summary-1', sessionId: 'fixture-session',
      timestamp: '2026-10-08T11:01:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'continued context' }] } },
    row('user', 'cu2', 'continued-1', 'after compact'), row('assistant', 'ca2', 'cu2', 'after answer'),
  ];
  await append(file, compactAppend); await sync.tick();
  assert.equal(runtime.applyCount, 1);
  assert.equal(runtime.source.paused, false);
  assert.equal(runtime.target.checkpoint.turns.length, 2);

  await append(file, [row('user', 'cu3', 'ca2', 'later prompt'), row('assistant', 'ca3', 'cu3', 'later answer')]);
  await sync.tick();
  assert.equal(runtime.applyCount, 2, 'a normal append after compaction must continue syncing');
  assert.equal(runtime.target.checkpoint.turns.length, 3);

  await append(file, [
    { type: 'system', subtype: 'compact_boundary', uuid: 'compact-2', parentUuid: null,
      logicalParentUuid: 'ca3', sessionId: 'fixture-session', timestamp: '2026-10-08T11:03:00.000Z' },
    { type: 'user', uuid: 'summary-2', parentUuid: 'compact-2', sessionId: 'fixture-session',
      timestamp: '2026-10-08T11:03:01.000Z', isCompactSummary: true,
      message: { role: 'user', content: 'second synthetic summary' } },
    row('user', 'cu4', 'summary-2', 'after second compact'), row('assistant', 'ca4', 'cu4', 'fourth answer'),
  ]);
  await sync.tick();
  assert.equal(runtime.applyCount, 3, 'a second compact boundary must preserve the synchronized prefix');
  assert.equal(runtime.target.checkpoint.turns.length, 4);
  await sync.stop(); await fs.rm(directory, { recursive: true, force: true });
}

Promise.resolve()
  .then(testAppendIdempotentPartialAndQueue)
  .then(testRewriteBranchTruncateBusyAndHostConflict)
  .then(testFingerprintRoundTripAndStop)
  .then(testProductionProjectionIsDeterministic)
  .then(testCompactionBridgeAndFollowingAppend)
  .then(() => console.log('claude history sync tests passed'))
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
