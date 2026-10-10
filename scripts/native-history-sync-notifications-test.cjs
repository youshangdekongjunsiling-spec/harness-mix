const assert = require('node:assert/strict');
const { CoreSession } = require('../src/main/host/core-session');
const { NativeProtocol } = require('../src/main/native/protocol');
const { projectClaudeHistory } = require('../src/main/host/claude-history');
const thread = { id: 'synthetic-sync-thread', harnessId: 'claude', nativeSessionId: 'synthetic-native', cwd: process.cwd(), title: 'Synthetic sync', createdAt: 1000, updatedAt: 2000,
  messages: projectClaudeHistory([
    { type: 'user', uuid: 'user-1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Hello' } },
    { type: 'assistant', uuid: 'assistant-1', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'text', text: 'Hello back' }], stop_reason: 'end_turn' } },
  ]) };
const execution = new CoreSession();
execution.threadCreated(thread);
let listener;
const runtime = { core: execution.core, execution, threads: [thread], adapters: new Map(), catalogs: new Map(), getThread: () => thread,
  subscribe(fn) { listener = fn; return () => {}; } };
const events = [];
const protocol = new NativeProtocol(runtime, event => events.push(event));
try {
  const turn = runtime.core.turns.turnsForThread(thread.id).at(-1);
  const items = runtime.core.getItemsForTurn(turn.id);
  listener({ type: 'native-history-synced', thread, newTurnIds: [turn.id], changedTurnIds: [turn.id], changedItemIds: items.map(item => item.id) });
  assert.equal(events.filter(event => event.method === 'turn/started').length, 1);
  assert.equal(events.filter(event => event.method === 'turn/completed').length, 1);
  assert.equal(events.filter(event => event.method === 'item/started').length, items.length);
  assert.deepEqual(events.filter(event => event.method === 'item/completed').map(event => event.params.item.id), items.map(item => item.id));
  assert(events.some(event => event.method === 'thread/status/changed' && event.params.status.type === 'idle'));
  assert(!events.some(event => event.method.endsWith('/delta')));
  thread.archived = true;
  const archivedEventCount = events.length;
  listener({ type: 'native-history-synced', thread, newTurnIds: [turn.id], changedTurnIds: [turn.id], changedItemIds: items.map(item => item.id) });
  assert.equal(events.length, archivedEventCount,
    'archived history sync does not emit thread or turn notifications that can resurrect it');
  thread.archived = false;
  listener({ type: 'native-history-sync-status', threadId: thread.id, status: 'paused', reason: 'branch-changed' });
  assert.equal(events.at(-1).method, 'harnessmix/thread/nativeHistorySync/updated');
  console.log('PASS: stable sync item IDs, completed turns, idle state and pause notice');
} finally { protocol.close(); }
