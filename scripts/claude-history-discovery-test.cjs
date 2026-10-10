const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ClaudeHistorySync, DEFAULT_DISCOVERY_INTERVAL_MS } = require('../src/main/host/claude-history-sync');
const { HostRuntime } = require('../src/main/host/runtime');
const { createClaudeHistorySyncOptions } = require('../src/main/native/claude-sync-options');
const { createClaudeHistoryDiscovery, discoveredThreadId, isStandaloneHealthProbe }
  = require('../src/main/native/claude-history-discovery');

const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const sessionRow = (sessionId, cwd, type, uuid, parentUuid, content, extra = {}) => ({
  type, uuid, parentUuid, sessionId, cwd, timestamp: new Date(1_800_000_000_000
    + Number(uuid.replace(/\D/g, '') || 0)).toISOString(), ...extra,
  message: { role: type, content, ...(type === 'assistant' ? { stop_reason: 'end_turn' } : {}) },
});

async function main() {
  assert.equal(DEFAULT_DISCOVERY_INTERVAL_MS, 30_000);
  assert.equal(createClaudeHistoryDiscovery({ environment: {} }), null, 'discovery is opt-in');
  const probeRows = [
    sessionRow('probe', process.cwd(), 'user', 'probe-u1', null,
      [{ type: 'text', text: 'Reply exactly HARNESS_MIX_HEALTH_OK. Do not use tools or modify files.' }]),
    sessionRow('probe', process.cwd(), 'assistant', 'probe-a1', 'probe-u1',
      [{ type: 'text', text: 'HARNESS_MIX_HEALTH_OK' }]),
  ];
  assert.equal(isStandaloneHealthProbe(probeRows), true);
  assert.equal(isStandaloneHealthProbe([...probeRows,
    sessionRow('probe', process.cwd(), 'user', 'probe-u2', 'probe-a1', [{ type: 'text', text: 'real work' }])]), false,
  'a health session with appended user work remains discoverable');
  assert.equal(isStandaloneHealthProbe([probeRows[0], { ...probeRows[1], message: { role: 'assistant',
    content: [{ type: 'text', text: 'HARNESS_MIX_HEALTH_OK' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }]), false,
  'a health-shaped transcript with tool use remains discoverable');
  assert.equal(isStandaloneHealthProbe([{ ...probeRows[0], message: { role: 'user',
    content: [{ type: 'text', text: 'Reply exactly HARNESS_MIX_HEALTH_OK. Do not use tools or modify files.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] } },
  probeRows[1]]), false, 'non-text probe content remains discoverable');
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
  const probeId = '77777777-7777-4777-8777-777777777777';
  const markerId = '88888888-8888-4888-8888-888888888888';
  const validFile = path.join(project, validId + '.jsonl');
  const partialFile = path.join(project, partialId + '.jsonl');
  const sideFile = path.join(project, sideId + '.jsonl');
  const probeFile = path.join(project, probeId + '.jsonl');
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
  await fsp.writeFile(probeFile, encode([
    sessionRow(probeId, cwd, 'user', 'hu1', null,
      [{ type: 'text', text: 'Reply exactly HARNESS_MIX_HEALTH_OK. Do not use tools or modify files.' }]),
    sessionRow(probeId, cwd, 'assistant', 'ha1', 'hu1', [{ type: 'text', text: 'HARNESS_MIX_HEALTH_OK' }]),
  ]));
  await fsp.writeFile(path.join(project, markerId + '.jsonl'), encode([
    sessionRow(markerId, cwd, 'user', 'mu1', null,
      [{ type: 'text', text: 'Explain what HARNESS_MIX_HEALTH_OK means.' }]),
    sessionRow(markerId, cwd, 'assistant', 'ma1', 'mu1', [{ type: 'text', text: 'It is a health marker.' }]),
  ]));

  const reads = new Map();
  const fileSystem = { ...fsp, readFile: async file => {
    reads.set(String(file), (reads.get(String(file)) || 0) + 1);
    return fsp.readFile(file);
  } };
  const environment = { HARNESSMIX_CLAUDE_HISTORY_DISCOVERY: '1' };
  const discover = createClaudeHistoryDiscovery({ environment, home, fileSystem });
  const first = await discover();
  assert.equal(first.some(candidate => candidate.nativeSessionId === probeId), false,
    'the exact standalone health probe is not imported');
  assert.equal(first.some(candidate => candidate.nativeSessionId === markerId), true,
    'ordinary conversations containing the marker remain discoverable');
  const firstValid = first.find(candidate => candidate.nativeSessionId === validId);
  assert(firstValid);
  assert.match(firstValid.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(firstValid.id, discoveredThreadId(validId), 'auto-import identity is deterministic');
  assert.equal(firstValid.nativeHistorySync.enabled, true);
  assert.equal(firstValid.nativeHistorySync.cursor.branchCount, 2);
  assert.equal(firstValid.coreState.turns.length, 1);
  const partialReads = reads.get(partialFile);
  const sideReads = reads.get(sideFile);
  const second = await discover({ knownNativeSessions: [{ harnessId: 'claude', nativeSessionId: validId }] });
  assert.equal(second.some(candidate => candidate.nativeSessionId === validId), false);
  assert.equal(reads.get(partialFile), partialReads, 'unchanged incomplete source is cached');
  assert.equal(reads.get(sideFile), sideReads, 'unchanged sidechain source is cached');
  const afterFork = await discover({ knownNativeSessions: [{ harnessId: 'claude',
    nativeSessionId: '66666666-6666-4666-8666-666666666666' }] });
  const forkOrigin = afterFork.find(candidate => candidate.nativeSessionId === validId);
  assert(forkOrigin, 'the preserved origin remains independently discoverable after its Host thread forks');
  assert.equal(forkOrigin.nativeSessionFile, validFile);
  assert.equal(forkOrigin.id, discoveredThreadId(validId));
  assert.equal(forkOrigin.nativeHistorySync.enabled, true);

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
  assert.equal(runtime.threads.some(thread => thread.nativeSessionId === validId), true);
  assert(events.includes('thread-created'), 'auto import uses the existing sidebar notification path');

  await fsp.appendFile(validFile, encode([
    sessionRow(validId, cwd, 'user', 'u2', 'a1', [{ type: 'text', text: 'second prompt' }]),
    sessionRow(validId, cwd, 'assistant', 'a2', 'u2', [{ type: 'text', text: 'second answer' }]),
  ]));
  runtime.claudeHistorySync.stopped = false;
  await runtime.claudeHistorySync.tick();
  runtime.claudeHistorySync.stopped = true;
  const imported = runtime.getThread(firstValid.id);
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
  assert.equal(restarted.threads.filter(thread => thread.nativeSessionId === validId).length, 1,
    'restart scan does not duplicate an imported native identity');
  await restarted.removeThread(firstValid.id);
  assert.equal(await restarted.store.wasRemoved({ threadId: firstValid.id, harnessId: 'claude',
    nativeSessionId: validId }), true);
  restarted.claudeHistorySync.nextDiscoveryAt = 0;
  restarted.claudeHistorySync.stopped = false;
  await restarted.claudeHistorySync.tick();
  restarted.claudeHistorySync.stopped = true;
  assert.equal(restarted.threads.some(thread => thread.nativeSessionId === validId), false,
    'a deleted auto-import stays deleted');

  await restarted.store.markRemoved('manual-thread', { harnessId: 'claude', nativeSessionId: partialId });
  assert.equal(await restarted.importDiscoveredHistorySource({ ...firstValid, id: discoveredThreadId(partialId),
    nativeSessionId: partialId }), null, 'native identity tombstones also cover manually imported threads');
  await restarted.close();

  await new Promise(resolve => setTimeout(resolve, 10));
  await fsp.appendFile(probeFile, encode([
    sessionRow(probeId, cwd, 'user', 'hu2', 'ha1', [{ type: 'text', text: 'now do real work' }]),
    sessionRow(probeId, cwd, 'assistant', 'ha2', 'hu2', [{ type: 'text', text: 'real answer' }]),
  ]));
  const grownProbe = await discover({ knownNativeSessions: [
    { harnessId: 'claude', nativeSessionId: validId },
    { harnessId: 'claude', nativeSessionId: markerId },
  ] });
  assert.equal(grownProbe.some(candidate => candidate.nativeSessionId === probeId), true,
    'a filtered health probe is reconsidered after its file grows with real work');

  const lineageStore = path.join(root, 'lineage-store');
  const lineageRuntime = new HostRuntime({ dataDirectory: lineageStore,
    claudeHistorySync: createClaudeHistorySyncOptions() });
  lineageRuntime.threads = [{ id: 'fork-thread', harnessId: 'claude', nativeSessionId: 'fork-native',
    title: 'Current task', cwd, createdAt: 1, updatedAt: 3_000, status: 'ready', connectionStatus: 'ready',
    messages: [], tools: [], pendingApprovals: [], rewindHistory: [
      { nativeSessionId: validId, at: 2_000_000_000_000 },
      { nativeSessionId: partialId, at: 2_000_000_000_000 },
    ] }];
  const quietOrigin = await lineageRuntime.importDiscoveredHistorySource(firstValid);
  assert.equal(quietOrigin.title, '[原始分支] Current task');
  assert.equal(quietOrigin.titleLocked, true);
  assert.equal(quietOrigin.archived, true, 'an unchanged origin is archived only on its first import');
  assert.deepEqual(quietOrigin.nativeHistoryLineage, { relation: 'rewind-origin',
    forkThreadId: 'fork-thread', forkNativeSessionId: 'fork-native', forkedAt: 2_000_000_000_000,
    autoArchived: true });
  lineageRuntime.claudeHistorySync.stopped = false;
  await lineageRuntime.claudeHistorySync.tick();
  lineageRuntime.claudeHistorySync.stopped = true;
  assert.equal(quietOrigin.archived, false, 'new original-branch work resurfaces an auto-archived origin');
  assert.equal(quietOrigin.nativeHistoryLineage.autoArchived, undefined);
  await lineageRuntime.setThreadArchived(quietOrigin.id, true);
  await fsp.appendFile(validFile, encode([
    sessionRow(validId, cwd, 'user', 'u3', 'a2', [{ type: 'text', text: 'third prompt' }]),
    sessionRow(validId, cwd, 'assistant', 'a3', 'u3', [{ type: 'text', text: 'third answer' }]),
  ]));
  lineageRuntime.claudeHistorySync.stopped = false;
  await lineageRuntime.claudeHistorySync.tick();
  lineageRuntime.claudeHistorySync.stopped = true;
  assert.equal(quietOrigin.archived, true, 'later sync respects an explicit manual archive');
  const activeOrigin = await lineageRuntime.importDiscoveredHistorySource({ ...firstValid,
    id: discoveredThreadId(partialId), nativeSessionId: partialId, updatedAt: 2_000_000_000_001 });
  assert.notEqual(activeOrigin.archived, true, 'newer independent work on the original branch remains visible');
  await lineageRuntime.setThreadArchived(quietOrigin.id, false);
  await lineageRuntime.close();

  const lineageRestarted = new HostRuntime({ dataDirectory: lineageStore });
  lineageRestarted.threads = await lineageRestarted.store.loadIndex();
  const existingOrigin = await lineageRestarted.importDiscoveredHistorySource(firstValid);
  assert.equal(existingOrigin.archived, false, 'restart discovery respects a manual unarchive');
  assert.deepEqual(existingOrigin.nativeHistoryLineage, quietOrigin.nativeHistoryLineage,
    'lineage metadata survives compact index reload');
  await lineageRestarted.close();

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
