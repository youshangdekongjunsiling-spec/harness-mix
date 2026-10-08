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
    this.source = { threadId: this.threadId, harnessId: 'claude', sourceFile: file, enabled: true,
      paused: false, status: 'synced', cursor: {} };
    this.target = initial;
    this.applyCount = 0;
    this.statuses = [];
    this.busy = false;
  }
  listClaudeHistorySyncSources() { return [{ ...this.source, cursor: { ...this.source.cursor } }]; }
  isClaudeHistorySyncBusy() { return this.busy; }
  prepareClaudeHistorySync() { return { thread: { id: this.threadId }, checkpoint: this.target.checkpoint }; }
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
    messages: [], tools: [], pendingApprovals: [], usage: {} } };
  const snapshot = options.readSnapshot({ rows, target, completeBytes: encode(rows).length });
  const first = options.applySnapshot({ snapshot, target });
  const second = options.applySnapshot({ snapshot, target });
  assert.equal(checkpointFingerprint(first.checkpoint), checkpointFingerprint(second.checkpoint));
  assert.equal(first.nativeHistorySnapshot.sourceMessageCount, 2);
  assert.equal(first.checkpoint.turns.length, 1);
}

Promise.resolve()
  .then(testAppendIdempotentPartialAndQueue)
  .then(testRewriteBranchTruncateBusyAndHostConflict)
  .then(testFingerprintRoundTripAndStop)
  .then(testProductionProjectionIsDeterministic)
  .then(() => console.log('claude history sync tests passed'))
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
