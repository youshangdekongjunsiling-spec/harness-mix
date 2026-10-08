const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CodexAppServer } = require('../adapters/codex-app-server');
const { projectClaudeHistory, mergeClaudeTimestamps } = require('./claude-history');

const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(v => v.type === 'text' || v.type === 'input_text').map(v => v.text || '').join('\n') : '';
const message = (role, value, at) => ({ id: randomUUID(), role, text: text(value), at: at || 0 });

async function claudeSessionFile(sessionId, cwd) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId || '')) return null;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, `${sessionId}.jsonl`);
    try { if ((await fs.stat(file)).isFile()) matches.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (matches.length <= 1) return matches[0] ?? null;
  for (const file of matches) {
    const rows = await claudeRawEntries(file);
    if (rows.some(row => row?.sessionId === sessionId && row.cwd === cwd)) return file;
  }
  return null;
}

async function claudeRawEntries(file) {
  if (!file) return [];
  try {
    const data = await fs.readFile(file, 'utf8');
    return data.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function piRows(directory) {
  const rows = [];
  async function visit(dir, depth) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) await visit(file, depth + 1);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const stat = await fs.stat(file);
      if (stat.size > 32 * 1024 * 1024) continue;
      const lines = (await fs.readFile(file, 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const header = lines.find(e => e.type === 'session');
      if (!header?.id || !path.isAbsolute(header.cwd || '')) continue;
      const byId = new Map(lines.filter(e => e.id).map(e => [e.id, e]));
      const branch = [], visited = new Set();
      let leaf = lines.findLast(e => e.id && e.type !== 'session');
      while (leaf && !visited.has(leaf.id)) { visited.add(leaf.id); branch.unshift(leaf); leaf = byId.get(leaf.parentId); }
      const messages = branch.filter(e => e.type === 'message' && ['user', 'assistant'].includes(e.message?.role)).map(e => message(e.message.role, e.message.content, Date.parse(e.timestamp)));
      rows.push({ nativeSessionId: header.id, cwd: header.cwd, updatedAt: Math.floor(stat.mtimeMs), title: lines.findLast(e => e.type === 'session_info')?.name || messages.find(m => m.role === 'user')?.text.slice(0, 120) || null, running: null, messages, nativeSessionFile: file });
    }
  }
  await visit(directory, 0);
  return rows;
}

async function listNative(harnessId) {
  if (harnessId === 'codebuddy') return require('../adapters/codebuddy-history').listCodeBuddyHistory();
  if (harnessId === 'pi') return piRows(path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions'));
  if (harnessId === 'claude') {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const sessions = (await sdk.listSessions()).filter(s => path.isAbsolute(s.cwd || ''));
    return Promise.all(sessions.map(async s => ({ nativeSessionId: s.sessionId, title: s.customTitle || s.summary || null, cwd: s.cwd,
      updatedAt: s.lastModified, running: null, nativeSessionFile: await claudeSessionFile(s.sessionId, s.cwd) })));
  }
  if (harnessId === 'codex') {
    const host = await CodexAppServer.acquire();
    try {
      const rows = []; let cursor;
      do {
        const page = await host.request('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        rows.push(...page.data.filter(s => path.isAbsolute(s.cwd || '')).map(s => ({ nativeSessionId: s.id, title: s.name || s.preview || null, cwd: s.cwd, updatedAt: s.updatedAt * 1000, running: s.status?.type === 'active' ? true : null })));
        cursor = page.nextCursor;
      } while (cursor);
      return rows;
    } finally { host.release(); }
  }
  return [];
}

async function readNative(harnessId, candidate) {
  if (harnessId === 'codebuddy') {
    const history = require('../adapters/codebuddy-history');
    return history.messages(await history.readCodeBuddyHistory(candidate.cwd, candidate.nativeSessionId));
  }
  if (candidate.messages) return candidate.messages;
  if (harnessId === 'claude') {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    // The SDK resolves the active parentUuid branch. Its runtime currently returns
    // timestamps, but the public SessionMessage type does not promise them. Rejoin
    // the raw JSONL timestamp by stable uuid so future SDK versions cannot collapse
    // an import to epoch zero.
    const rows = await sdk.getSessionMessages(candidate.nativeSessionId, { dir: candidate.cwd });
    const sourceFile = candidate.nativeSessionFile || await claudeSessionFile(candidate.nativeSessionId, candidate.cwd);
    const enriched = mergeClaudeTimestamps(rows, await claudeRawEntries(sourceFile), candidate.updatedAt);
    // Preserve Claude's block structure so tool_result protocol rows remain tools,
    // rather than becoming empty user messages in the imported conversation.
    return projectClaudeHistory(enriched);
  }
  if (harnessId === 'codex') {
    const host = await CodexAppServer.acquire();
    try {
      const { thread } = await host.request('thread/read', { threadId: candidate.nativeSessionId, includeTurns: true });
      return (thread.turns || []).flatMap(t => (t.items || []).flatMap(i => i.type === 'userMessage' ? [message('user', i.content, candidate.updatedAt)] : i.type === 'agentMessage' ? [message('assistant', i.text, candidate.updatedAt)] : []));
    } finally { host.release(); }
  }
  return [];
}

module.exports = { listNative, readNative };
