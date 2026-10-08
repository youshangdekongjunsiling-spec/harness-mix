const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { selectClaudeBranch } = require('../host/claude-history');
const { branchChain, checkpointFingerprint, hashBytes, hashPrefix, parseCompleteJsonl }
  = require('../host/claude-history-sync');
const { createClaudeHistorySyncOptions } = require('./claude-sync-options');

const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function discoveredThreadId(nativeSessionId) {
  const bytes = crypto.createHash('sha256').update('claude\0' + nativeSessionId).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
    + hex.slice(16, 20) + '-' + hex.slice(20);
}

function visibleUser(row) {
  if (row?.type !== 'user' || row.isCompactSummary) return false;
  const content = row.message?.content;
  if (typeof content === 'string') return Boolean(content.trim());
  return Array.isArray(content) && content.some(block => (block?.type === 'text'
    && typeof block.text === 'string' && block.text.trim()) || block?.type === 'image');
}

function createClaudeHistoryDiscovery({ environment = process.env, home = os.homedir(),
  fileSystem = fs } = {}) {
  if (environment.HARNESSMIX_CLAUDE_HISTORY_DISCOVERY !== '1') return null;
  const root = path.join(environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
  const rejected = new Map();

  return async function discoverClaudeHistorySources({ knownNativeSessions = [] } = {}) {
    const known = new Set(knownNativeSessions.filter(row => row?.harnessId === 'claude')
      .map(row => row.nativeSessionId));
    const projects = await fileSystem.readdir(root, { withFileTypes: true })
      .catch(() => []);
    const files = [];
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const directory = path.join(root, project.name);
      const entries = await fileSystem.readdir(directory, { withFileTypes: true })
        .catch(() => []);
      for (const entry of entries) {
        const match = entry.isFile() && !entry.isSymbolicLink() ? entry.name.match(SESSION_FILE) : null;
        if (match && !known.has(match[1])) files.push({ file: path.join(directory, entry.name), nativeSessionId: match[1] });
      }
    }

    const discovered = [];
    for (const entry of files.sort((left, right) => left.file.localeCompare(right.file))) {
      let stat;
      try { stat = await fileSystem.stat(entry.file); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      const signature = String(stat.size) + ':' + String(stat.mtimeMs);
      if (rejected.get(entry.file) === signature) continue;
      let buffer;
      try { buffer = await fileSystem.readFile(entry.file); } catch { continue; }
      const after = await fileSystem.stat(entry.file).catch(() => null);
      if (!after?.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || after.size !== buffer.length) continue;

      try {
        const parsed = parseCompleteJsonl(buffer);
        if (parsed.hasPartialTail || parsed.completeBytes !== buffer.length) throw new Error('incomplete JSONL');
        const sessionRows = parsed.rows.filter(row => (row?.sessionId ?? row?.session_id) === entry.nativeSessionId);
        const cwd = sessionRows.map(row => row.cwd).find(value => typeof value === 'string' && path.isAbsolute(value));
        if (!cwd) throw new Error('missing absolute cwd');
        const branchRows = selectClaudeBranch(parsed.rows);
        if (!branchRows.some(visibleUser) || !branchRows.some(row => row.type === 'assistant')) {
          throw new Error('incomplete conversation');
        }
        if (branchRows.some(row => (row.sessionId ?? row.session_id) !== entry.nativeSessionId)) {
          throw new Error('mixed session identity');
        }

        const id = discoveredThreadId(entry.nativeSessionId);
        const timestamps = branchRows.map(row => Date.parse(row.timestamp)).filter(Number.isFinite);
        const base = { id, harnessId: 'claude', nativeSessionId: entry.nativeSessionId,
          nativeSessionFile: entry.file, cwd, title: '导入的 Claude 会话',
          createdAt: Math.min(...timestamps), updatedAt: Math.max(...timestamps),
          status: 'ready', connectionStatus: 'ready', restore: true, options: {},
          messages: [], tools: [], pendingApprovals: [] };
        const projection = createClaudeHistorySyncOptions({ environment: {} });
        const target = { thread: base, checkpoint: null };
        const snapshot = projection.readSnapshot({ rows: parsed.rows, target, completeBytes: parsed.completeBytes });
        const candidate = projection.applySnapshot({ snapshot, target });
        const firstUser = candidate.messages.find(message => message.role === 'user' && message.text)?.text?.trim();
        const chain = branchChain(snapshot.branchRows);
        const cursor = { observedSize: after.size, observedMtimeMs: after.mtimeMs,
          appliedSize: parsed.completeBytes, sourcePrefixHash: hashBytes(buffer, parsed.completeBytes),
          branchCount: chain.length, prefixHash: hashPrefix(chain),
          leafUuid: snapshot.branchRows.at(-1)?.uuid ?? null,
          targetFingerprint: checkpointFingerprint(candidate.checkpoint) };
        discovered.push({ ...base, title: firstUser?.slice(0, 120) || base.title,
          createdAt: candidate.checkpoint.turns[0]?.createdAt ?? base.createdAt,
          updatedAt: candidate.updatedAt, messages: candidate.messages,
          coreState: candidate.checkpoint, nativeHistorySnapshot: candidate.nativeHistorySnapshot,
          nativeHistorySync: { enabled: true, paused: false, status: 'synced',
            sourceFile: entry.file, checkedAt: Date.now(), cursor } });
        rejected.delete(entry.file);
      } catch {
        rejected.set(entry.file, signature);
      }
    }
    return discovered;
  };
}

module.exports = { createClaudeHistoryDiscovery, discoveredThreadId };

