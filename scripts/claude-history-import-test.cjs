const assert = require('node:assert/strict');
const { projectClaudeHistory, selectClaudeBranch, mergeClaudeTimestamps } = require('../src/main/host/claude-history');
const { ProtocolCore } = require('../src/main/protocol-core/protocol-core');
const { importHistory } = require('../src/main/host/history-import');

const rows = [
  { type: 'user', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-10-08T10:00:00.000Z', message: { role: 'user', content: 'first prompt' } },
  { type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-10-08T10:00:01.000Z', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'fixture.txt' } },
  ] } },
  { type: 'user', uuid: 'tr1', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-10-08T10:00:02.000Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'fixture output' },
  ] } },
  { type: 'assistant', uuid: 'a2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-10-08T10:00:03.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [
    { type: 'text', text: 'first answer' },
  ] } },
  { type: 'user', uuid: 'u2', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-10-08T10:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }] } },
  { type: 'assistant', uuid: 'sub', session_id: 's1', parent_tool_use_id: 'parent-tool', timestamp: '2026-10-08T10:01:00.500Z', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent text' }] } },
  { type: 'assistant', uuid: 'a3', session_id: 's1', parent_tool_use_id: null, timestamp: '2026-10-08T10:01:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } },
];

const branched = selectClaudeBranch([
  { ...rows[0], sessionId: 's1', parentUuid: null },
  { type: 'assistant', uuid: 'old-fork', sessionId: 's1', parentUuid: 'u1', timestamp: '2026-10-08T09:59:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'old fork' }] } },
  { ...rows[1], sessionId: 's1', parentUuid: 'u1' },
  { ...rows[2], sessionId: 's1', parentUuid: 'a1' },
  { ...rows[3], sessionId: 's1', parentUuid: 'tr1' },
  { type: 'assistant', uuid: 'side', sessionId: 's1', parentUuid: 'u1', isSidechain: true, timestamp: '2026-10-08T10:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain' }] } },
]);
assert.deepEqual(branched.map(row => row.uuid), ['u1', 'a1', 'tr1', 'a2']);

const enriched = mergeClaudeTimestamps([
  { uuid: 'raw-time' },
  { uuid: 'sdk-time', timestamp: '2026-10-08T11:00:00.000Z' },
  { uuid: 'fallback-time' },
], [{ uuid: 'raw-time', timestamp: '2026-10-08T10:59:00.000Z' }], Date.parse('2026-10-08T12:00:00.000Z'));
assert.deepEqual(enriched.map(row => row.timestamp), [
  '2026-10-08T10:59:00.000Z',
  '2026-10-08T11:00:00.000Z',
  '2026-10-08T12:00:00.000Z',
]);
assert.throws(() => mergeClaudeTimestamps([{ uuid: 'missing' }]), /has no timestamp/);

const messages = projectClaudeHistory(rows);
assert.equal(messages.length, 4);
assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.text), ['first prompt', 'second prompt']);
assert.deepEqual(messages.filter(message => message.role === 'user').map(message => message.at), [Date.parse(rows[0].timestamp), Date.parse(rows[4].timestamp)]);
assert.equal(messages.some(message => message.text === ''), false);

const firstAssistant = messages[1];
assert.deepEqual(firstAssistant.items.map(item => item.kind), ['tool', 'text']);
assert.equal(firstAssistant.items[0].tool.input.path, 'fixture.txt');
assert.equal(firstAssistant.items[0].tool.output, 'fixture output');
assert.equal(firstAssistant.items[0].tool.state, 'done');
assert.equal(firstAssistant.items[0].tool.endedAt, Date.parse(rows[2].timestamp));
assert.equal(firstAssistant.items[1].phase, 'final');
assert.equal(firstAssistant.nativeStopReason, 'end_turn');

const core = new ProtocolCore();
const thread = { id: 'imported', cwd: 'C:\\fixture', harnessId: 'claude', nativeSessionId: 's1', title: 'fixture', createdAt: 1, updatedAt: Date.parse(rows.at(-1).timestamp), messages, tools: [] };
importHistory(core, thread);
const turns = core.turns.turnsForThread(thread.id);
assert.equal(turns.length, 2);
const firstItems = core.getItemsForTurn(turns[0].id);
assert.deepEqual(firstItems.map(item => item.type), ['user_message', 'tool_call', 'agent_message']);
assert.equal(firstItems[0].createdAt, Date.parse(rows[0].timestamp));
assert.equal(firstItems[1].nativeRef.toolCallId, 'tool-1');
assert.equal(firstItems[1].input.path, 'fixture.txt');
assert.equal(firstItems[1].output, 'fixture output');
assert.equal(firstItems[1].updatedAt, Date.parse(rows[2].timestamp));
assert.equal(firstItems[2].phase, 'final');
assert.equal(core.getItemsForTurn(turns[1].id).filter(item => item.type === 'user_message').length, 1);
assert.equal(turns[1].status, 'cancelled');

console.log('claude history import tests passed');
