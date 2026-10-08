const { randomUUID } = require('node:crypto');

function timestamp(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function contentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content.filter(block => block && typeof block === 'object') : [];
}

function mergeClaudeTimestamps(rows, rawEntries = [], fallbackTimestamp) {
  const raw = new Map(rawEntries.flatMap(entry => typeof entry?.uuid === 'string' && typeof entry.timestamp === 'string'
    && Number.isFinite(Date.parse(entry.timestamp)) ? [[entry.uuid, entry.timestamp]] : []));
  return (rows ?? []).map(row => {
    const value = raw.get(row.uuid) ?? row.timestamp;
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return { ...row, timestamp: value };
    if (Number.isFinite(fallbackTimestamp)) return { ...row, timestamp: new Date(fallbackTimestamp).toISOString() };
    throw new Error(`Claude history message ${row?.uuid || '<unknown>'} has no timestamp`);
  });
}

function userContent(content) {
  const blocks = contentBlocks(content);
  const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).filter(Boolean).join('\n\n');
  const attachments = blocks.flatMap((block, index) => {
    if (block.type !== 'image' || block.source?.type !== 'base64' || typeof block.source.data !== 'string') return [];
    return [{ kind: 'image', name: `claude-image-${index + 1}`, mime: block.source.media_type || 'image/png', data: block.source.data }];
  });
  return { text, attachments };
}

// Mirrors the Claude SDK's parentUuid branch selection for frozen JSONL
// snapshots. Keeping this pure makes repair artifacts reproducible while a live
// Claude process continues appending to its transcript.
function selectClaudeBranch(entries) {
  const rows = (entries ?? []).filter(row => row && ['user', 'assistant', 'system', 'attachment'].includes(row.type) && typeof row.uuid === 'string');
  const byId = new Map(rows.map(row => [row.uuid, { ...row }]));
  const order = new Map(rows.map((row, index) => [row.uuid, index]));
  for (const row of byId.values()) {
    if (row.type !== 'system' || row.subtype !== 'compact_boundary') continue;
    // Claude starts a fresh physical parent chain after compaction, while
    // logicalParentUuid retains the append-only conversation edge. Prefer that
    // edge when the pre-compact row is still present in the JSONL. The
    // preserved-window metadata below is only a fallback for partial exports;
    // applying both would reparent old rows into a cycle and duplicate history.
    const logicalParent = row.logicalParentUuid ? byId.get(row.logicalParentUuid) : null;
    const sameSession = logicalParent && (logicalParent.sessionId ?? logicalParent.session_id)
      === (row.sessionId ?? row.session_id);
    if (logicalParent && sameSession && order.get(logicalParent.uuid) < order.get(row.uuid)) {
      byId.set(row.uuid, { ...row, parentUuid: logicalParent.uuid });
      continue;
    }
    const preserved = row.compactMetadata?.preservedMessages;
    const segment = row.compactMetadata?.preservedSegment;
    if (preserved?.uuids?.length && preserved.uuids.every(id => byId.has(id))) {
      let parent = preserved.anchorUuid;
      for (const id of preserved.uuids) { byId.set(id, { ...byId.get(id), parentUuid: parent }); parent = id; }
      const first = preserved.uuids[0], last = preserved.uuids.at(-1);
      for (const [id, value] of byId) if (value.parentUuid === preserved.anchorUuid && id !== first) byId.set(id, { ...value, parentUuid: last });
    } else if (segment) {
      if (byId.has(segment.headUuid)) byId.set(segment.headUuid, { ...byId.get(segment.headUuid), parentUuid: segment.anchorUuid });
      for (const [id, value] of byId) if (value.parentUuid === segment.anchorUuid && id !== segment.headUuid) byId.set(id, { ...value, parentUuid: segment.tailUuid });
    }
  }
  const parents = new Set([...byId.values()].map(row => row.parentUuid).filter(Boolean));
  const candidates = [];
  for (const leaf of [...byId.values()].filter(row => !parents.has(row.uuid))) {
    let row = leaf;
    const seen = new Set();
    while (row && !seen.has(row.uuid)) {
      seen.add(row.uuid);
      if (row.type === 'user' || row.type === 'assistant') { candidates.push(row); break; }
      row = row.parentUuid ? byId.get(row.parentUuid) : null;
    }
  }
  const primary = candidates.filter(row => !row.isSidechain && !row.teamName && !row.isMeta);
  const pool = primary.length ? primary : candidates;
  if (!pool.length) return [];
  const leaf = pool.reduce((latest, row) => (order.get(row.uuid) ?? -1) > (order.get(latest.uuid) ?? -1) ? row : latest);
  const chain = [], chainIds = new Set();
  for (let row = byId.get(leaf.uuid); row && !chainIds.has(row.uuid); row = row.parentUuid ? byId.get(row.parentUuid) : null) {
    chainIds.add(row.uuid); chain.push(row);
  }
  chain.reverse();

  // Preserve duplicate assistant API blocks and their tool results in the same
  // position as the SDK, even when those records are adjacent branches.
  const assistantByMessage = new Map();
  const duplicates = new Map();
  const toolResults = new Map();
  for (const row of byId.values()) {
    const messageId = row.type === 'assistant' && typeof row.message?.id === 'string' ? row.message.id : null;
    if (messageId) {
      assistantByMessage.set(messageId, row);
      const group = duplicates.get(messageId) ?? [];
      group.push(row); duplicates.set(messageId, group);
    } else if (row.type === 'user' && row.parentUuid && contentBlocks(row.message?.content).some(block => block.type === 'tool_result')) {
      const group = toolResults.get(row.parentUuid) ?? [];
      group.push(row); toolResults.set(row.parentUuid, group);
    }
  }
  const additions = new Map();
  for (const row of chain.filter(value => value.type === 'assistant')) {
    const messageId = typeof row.message?.id === 'string' ? row.message.id : null;
    if (!messageId || additions.has(assistantByMessage.get(messageId)?.uuid)) continue;
    const extra = [];
    for (const duplicate of duplicates.get(messageId) ?? []) {
      if (!chainIds.has(duplicate.uuid)) extra.push(duplicate);
      for (const result of toolResults.get(duplicate.uuid) ?? []) if (!chainIds.has(result.uuid)) extra.push(result);
    }
    extra.sort((left, right) => String(left.timestamp ?? '').localeCompare(String(right.timestamp ?? '')));
    if (extra.length) additions.set(assistantByMessage.get(messageId).uuid, extra);
  }
  const expanded = chain.flatMap(row => [row, ...(additions.get(row.uuid) ?? [])]);
  return expanded.filter(row => ['user', 'assistant'].includes(row.type) && !row.isSidechain && !row.teamName
    && !row.isMeta && !row.isCompactSummary)
    .map(row => ({ ...row, session_id: row.sessionId, parent_tool_use_id: null }));
}

function projectClaudeHistory(rows) {
  const messages = [];
  let turn = null;
  let sequence = 0;

  const finish = () => {
    if (!turn) return;
    const textItems = turn.items.filter(item => item.kind === 'text');
    if (turn.nativeStopReason === 'end_turn' && textItems.length) textItems.at(-1).phase = 'final';
    const assistant = {
      id: `claude-history-${turn.id || randomUUID()}`,
      role: 'assistant',
      at: turn.firstAssistantAt ?? turn.user.at,
      endedAt: turn.lastAt ?? turn.user.at,
      items: turn.items,
      nativeStopReason: turn.nativeStopReason ?? null,
      ...(!turn.nativeStopReason || turn.nativeStopReason === 'tool_use' ? { stopReason: 'interrupted' } : {}),
    };
    messages.push(turn.user, assistant);
    turn = null;
  };

  for (const row of rows ?? []) {
    if (!row || !['user', 'assistant'].includes(row.type) || row.parent_tool_use_id) continue;
    const at = timestamp(row.timestamp, 0);
    const blocks = contentBlocks(row.message?.content);

    if (row.type === 'user') {
      // Claude records tool results as user-role protocol messages. They update the
      // preceding tool call and must never create a visible user prompt.
      for (const block of blocks.filter(value => value.type === 'tool_result')) {
        const tool = turn?.tools.get(block.tool_use_id);
        if (tool) {
          tool.output = block.content;
          tool.state = block.is_error ? 'error' : 'done';
          tool.endedAt = at;
        }
        if (turn) turn.lastAt = Math.max(turn.lastAt, at);
      }

      const content = userContent(row.message?.content);
      if (!content.text && !content.attachments.length) continue;
      finish();
      turn = {
        id: row.uuid || `turn-${sequence++}`,
        user: { id: `claude-user-${row.uuid || randomUUID()}`, role: 'user', text: content.text, at,
          ...(content.attachments.length ? { attachments: content.attachments } : {}) },
        items: [], tools: new Map(), firstAssistantAt: null, lastAt: at, nativeStopReason: null,
      };
      continue;
    }

    // A branch without its initiating user prompt is incomplete. Do not invent
    // an empty user bubble for orphan assistant/tool protocol rows.
    if (!turn) continue;
    const active = turn;
    active.firstAssistantAt ??= at;
    active.lastAt = Math.max(active.lastAt, at);
    if (row.message?.stop_reason != null) active.nativeStopReason = row.message.stop_reason;
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        active.items.push({ kind: 'text', text: block.text, phase: 'progress', at });
      } else if (block.type === 'tool_use' && block.id) {
        const tool = { id: block.id, title: block.name || '工具', input: block.input, state: 'interrupted', at };
        active.tools.set(block.id, tool);
        active.items.push({ kind: 'tool', toolId: block.id, tool, at });
      }
    }
  }
  finish();
  return messages;
}

module.exports = { projectClaudeHistory, selectClaudeBranch, mergeClaudeTimestamps };
