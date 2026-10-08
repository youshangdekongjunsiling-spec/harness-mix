const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ClaudeHistorySync, DEFAULT_DISCOVERY_INTERVAL_MS } = require('../src/main/host/claude-history-sync');
const { HostRuntime } = require('../src/main/host/runtime');
const { createClaudeHistorySyncOptions } = require('../src/main/native/claude-sync-options');
const { createClaudeHistoryDiscovery, discoveredThreadId } = require('../src/main/native/claude-history-discovery');

const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const sessionRow = (sessionId, cwd, type, uuid, parentUuid, content, extra = {}) => ({
  type, uuid, parentUuid, sessionId, cwd, timestamp: new Date(1_800_000_000_000
    + Number(uuid.replace(/\D/g, '') || 0)).toISOString(), ...extra,
  message: { role: type, content, ...(type === 'assistant' ? { stop_reason: 'end_turn' } : {}) },
});

async function main() {
  assert.equal(DEFAULT_DISCOVERY_INTERVAL_MS, 30_000);
  assert.equal(createClaudeHistoryDiscovery({ environment: {} }), null, 'discovery is opt-in');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hm-claude-discovery-'));
  const home = path.join(root, 'home');
  const project = path.join(home, '.claude', 'projects', 'fixture');
  const cwd = path.join(root, 'workspace');
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(cwd, { recursive: true });

  const validId = '11111111-1111-4111-8111-111111111111';
  const partialId = '22222222-2222-4222-8222-222222222222';
  const sideId = '33333333-3333-4333-8333-333333333333';
  const emptyId = '44444444-4444-4444-8444-444444444444';
  const nestedId = '55555555-5555-4555-8555-555555555555';
  const validFile = path.join(project, validId + '.jsonl');
  const partialFile = path.join(project, partialId + '.jsonl');
  const sideFile = path.join(project, sideId + '.jsonl');
  await fsp.writeFile(validFile, encode([
    sessionRow(validId, cwd, 'user', 'u1', null, [{ type: 'text', text: 'first prompt' }]),
    sessionRow(validId, cwd, 'assistant', 'a1', 'u1', [{ type: 'text', text: 'first answer' }]),
  ]));
  await fsp.writeFile(partialFile, '{"type":"user"');
  await fsp.writeFile(sideFile, encode([
    sessionRow(sideId, cwd, 'user', 'su1', null, [{ type: 'text', text: 'side' }], { isSidechain: true }),
    sessionRow(sideId, cwd, 'assistant', 'sa1', 'su1', [{ type: 'text', text: 'side answer' }], { isSidechain: true }),
  ]));
  await fsp.writeFile(path.join(project, emptyId + '.jsonl'), '');
  const nested = path.join(project, 'session', 'subagents');
  await fsp.mkdir(nested, { recursive: true });
  await fsp.writeFile(path.join(nested, nestedId + '.jsonl'), encode([
    sessionRow(nestedId, cwd, 'user', 'nu1', null, [{ type: 'text', text: 'nested' }]),
    sessionRow(nestedId, cwd, 'assistant', 'na1', 'nu1', [{ type: 'text', text: 'nested answer' }]),
  ]));

  const reads = new Map();
  const fileSystem = { ...fsp, readFile: async file => {
    reads.set(String(file), (reads.get(String(file)) || 0) + 1);
    return fsp.readFile(file);
  } };
  const environment = { HARNESSMIX_CLAUDE_HISTORY_DISCOVERY: '1' };
  const discover = createClaudeHistoryDiscovery({ environment, home, fileSystem });
  const first = await discover();
  assert.equal(first.length, 1);
  assert.equal(first[0].nativeSessionId, validId);
  assert.match(first[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first[0].id, discoveredThreadId(validId), 'auto-import identity is deterministic');
  assert.equal(first[0].nativeHistorySync.enabled, true);
  assert.equal(first[0].nativeHistorySync.cursor.branchCount, 2);
  assert.equal(first[0].coreState.turns.length, 1);
  const partialReads = reads.get(partialFile);
  const sideReads = reads.get(sideFile);
  const second = await discover({ knownNativeSessions: [{ harnessId: 'claude', nativeSessionId: validId }] });
  assert.equal(second.length, 0);
  assert.equal(reads.get(partialFile), partialReads, 'unchanged incomplete source is cached');
  assert.equal(reads.get(sideFile), sideReads, 'unchanged sidechain source is cached');

  const store = path.join(root, 'store');
  const runtime = new HostRuntime({ dataDirectory: store, claudeHistorySync: {
    ...createClaudeHistorySyncOptions(), discoverSources: discover, discoveryIntervalMs: 30_000,
  } });
  runtime.threads = await runtime.store.loadIndex();
  const events = [];
  runtime.subscribe(event => events.push(event.type));
  runtime.claudeHistorySync.stopped = false;
  await runtime.claudeHistorySync.tick();
  runtime.claudeHistorySync.stopped = true;
  assert.equal(runtime.threads.length, 1);
  assert.equal(runtime.threads[0].nativeSessionId, validId);
  assert(events.includes('thread-created'), 'auto import uses the existing sidebar notification path');

  await fsp.appendFile(validFile, encode([
    sessionRow(validId, cwd, 'user', 'u2', 'a1', [{ type: 'text', text: 'second prompt' }]),
    sessionRow(validId, cwd, 'assistant', 'a2', 'u2', [{ type: 'text', text: 'second answer' }]),
  ]));
  runtime.claudeHistorySync.stopped = false;
  await runtime.claudeHistorySync.tick();
  runtime.claudeHistorySync.stopped = true;
  const imported = runtime.getThread(first[0].id);
  assert.equal(runtime.execution.checkpoint(imported).turns.length, 2,
    'a discovered thread continues with the normal incremental synchronizer');
  await runtime.close();

  const restarted = new HostRuntime({ dataDirectory: store, claudeHistorySync: {
    ...createClaudeHistorySyncOptions(), discoverSources: discover, discoveryIntervalMs: 30_000,
  } });
  restarted.threads = await restarted.store.loadIndex();
  restarted.claudeHistorySync.stopped = false;
  await restarted.claudeHistorySync.tick();
  restarted.claudeHistorySync.stopped = true;
  assert.equal(restarted.threads.length, 1, 'restart scan does not duplicate an imported native identity');
  await restarted.removeThread(first[0].id);
  assert.equal(await restarted.store.wasRemoved({ threadId: first[0].id, harnessId: 'claude',
    nativeSessionId: validId }), true);
  restarted.claudeHistorySync.nextDiscoveryAt = 0;
  restarted.claudeHistorySync.stopped = false;
  await restarted.claudeHistorySync.tick();
  restarted.claudeHistorySync.stopped = true;
  assert.equal(restarted.threads.length, 0, 'a deleted auto-import stays deleted');

  await restarted.store.markRemoved('manual-thread', { harnessId: 'claude', nativeSessionId: partialId });
  assert.equal(await restarted.importDiscoveredHistorySource({ ...first[0], id: discoveredThreadId(partialId),
    nativeSessionId: partialId }), null, 'native identity tombstones also cover manually imported threads');
  await restarted.close();

  await new Promise(resolve => setTimeout(resolve, 10));
  await fsp.writeFile(partialFile, encode([
    sessionRow(partialId, cwd, 'user', 'pu1', null, [{ type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]),
    sessionRow(partialId, cwd, 'assistant', 'pa1', 'pu1', [{ type: 'text', text: 'image answer' }]),
  ]));
  const afterGrowth = await discover({ knownNativeSessions: [{ harnessId: 'claude', nativeSessionId: validId }] });
  assert.equal(afterGrowth.some(candidate => candidate.nativeSessionId === partialId), true,
    'an incomplete source is reconsidered after size or mtime changes');

  const accepted = [];
  let discoveryCalls = 0;
  const scheduler = new ClaudeHistorySync({ intervalMs: 60_000, discoveryIntervalMs: 0,
    runtime: { listImportedNativeSessions: () => [], listClaudeHistorySyncSources: () => [],
      announceClaudeHistorySyncStatus() {}, importDiscoveredHistorySource: async candidate => {
        if (candidate.id === 'bad') throw new Error('fixture rejection');
        accepted.push(candidate.id);
      } },
    discoverSources: async () => { discoveryCalls += 1; return [{ id: 'bad' }, { id: 'good' }]; },
    readSnapshot: async () => ({}), applySnapshot: async () => ({}) });
  scheduler.start();
  await scheduler.tick();
  await scheduler.tick();
  await scheduler.stop();
  assert(accepted.includes('good'), 'one candidate failure does not block later candidates');
  assert(discoveryCalls >= 2, 'discovery interval is independent from the five-second sync interval');

  await fsp.rm(root, { recursive: true, force: true });
  console.log('claude history discovery tests passed');
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
