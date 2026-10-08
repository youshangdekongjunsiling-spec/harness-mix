const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { projectClaudeHistory, selectClaudeBranch } = require('../src/main/host/claude-history');
const { CoreSession } = require('../src/main/host/core-session');
const { compactThread } = require('../src/main/host/thread-storage');
const { fingerprint } = require('../src/main/native/pending-history-repair');

const usage = 'Usage: node scripts/build-claude-history-repair.cjs --snapshot <claude.jsonl> --baseline <thread-record.json> --output <local-directory>';

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]?.replace(/^--/, '')] = argv[index + 1];
  return result;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => sha256(fs.readFileSync(file));
const subsequence = (needle, haystack) => {
  let cursor = 0;
  for (const value of haystack) if (cursor < needle.length && value === needle[cursor]) cursor += 1;
  return cursor === needle.length;
};
const counts = values => values.reduce((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {});
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`${usage}\nWrites replacement-record.json and content-audit.json locally; it never modifies the live thread store.`);
    return;
  }
  const options = args(process.argv.slice(2));
  for (const name of ['snapshot', 'baseline', 'output']) assert(options[name], `${usage}\n--${name} is required`);
  const baseline = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
  assert.equal(baseline.harnessId, 'claude');
  assert.equal(typeof baseline.nativeSessionId, 'string');
  assert.equal(typeof baseline.cwd, 'string');
  const snapshotHash = fileHash(options.snapshot);
  const entries = fs.readFileSync(options.snapshot, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const mainRows = selectClaudeBranch(entries);
  const messages = projectClaudeHistory(mainRows);
  const projectedUsers = messages.filter(message => message.role === 'user');
  assert(projectedUsers.length > 0);
  assert(projectedUsers.every(message => message.text || message.attachments?.length), 'converter created an empty user message');

  const oldItems = baseline.coreState?.items ?? [];
  const oldUsers = oldItems.filter(item => item.type === 'user_message' && item.content).map(item => item.content);
  const oldAgents = oldItems.filter(item => item.type === 'agent_message' && item.content).map(item => item.content);
  const oldToolIds = oldItems.filter(item => item.type === 'tool_call').map(item => item.nativeRef?.toolCallId).filter(Boolean);
  const sourceUsers = mainRows.filter(row => row.type === 'user').map(row => userText(row.message?.content)).filter(Boolean);
  const sourceAgents = mainRows.filter(row => row.type === 'assistant').map(row => text(row.message?.content)).filter(Boolean);
  const sourceToolIds = mainRows.filter(row => row.type === 'assistant').flatMap(row => Array.isArray(row.message?.content)
    ? row.message.content.filter(block => block?.type === 'tool_use' && block.id).map(block => block.id) : []);
  const unexpectedTypes = [...new Set(oldItems.map(item => item.type).filter(type => !['user_message', 'agent_message', 'reasoning', 'usage'].includes(type)))];
  const safeToReplace = baseline.coreState?.thread?.id === baseline.id
    && subsequence(oldUsers, sourceUsers)
    && subsequence(oldAgents, sourceAgents)
    && oldToolIds.every(id => sourceToolIds.includes(id))
    && unexpectedTypes.length === 0;

  const createdAt = Math.min(...projectedUsers.map(message => message.at).filter(Number.isFinite));
  const updatedAt = Math.max(...messages.map(message => message.endedAt ?? message.at).filter(Number.isFinite));
  const replacement = { ...baseline, createdAt, updatedAt, messages, tools: [],
    nativeHistorySnapshot: { version: 1, source: 'claude', sourceSha256: snapshotHash,
      nativeSessionId: baseline.nativeSessionId, capturedAt: new Date().toISOString(), sourceMessageCount: mainRows.length } };
  delete replacement.coreState;
  delete replacement.storage;
  const execution = new CoreSession();
  execution.threadCreated(replacement);
  replacement.coreState = execution.checkpoint(replacement);
  const compact = compactThread(replacement);
  assert.equal(compact.id, baseline.id);
  assert.equal(compact.coreState.thread.id, baseline.id);

  const replacementText = JSON.stringify(compact, null, 2);
  const replacementFile = path.join(options.output, 'replacement-record.json');
  const auditFile = path.join(options.output, 'content-audit.json');
  fs.mkdirSync(options.output, { recursive: true });
  fs.writeFileSync(replacementFile, replacementText);
  const newItems = compact.coreState.items;
  const audit = {
    version: 1,
    safeToReplace,
    identity: { threadId: compact.id, harnessId: compact.harnessId, nativeSessionIdMatches: compact.nativeSessionId === baseline.nativeSessionId },
    hashes: { sourceSha256: snapshotHash, baselineSha256: fileHash(options.baseline), baselineFingerprint: fingerprint(baseline),
      replacementSha256: sha256(replacementText), replacementFingerprint: fingerprint(compact) },
    source: { mainMessageCount: mainRows.length, userPromptCount: sourceUsers.length, assistantMessageCount: mainRows.filter(row => row.type === 'assistant').length,
      toolUseCount: sourceToolIds.length },
    baseline: { itemTypes: counts(oldItems.map(item => item.type)), nonemptyUserCount: oldUsers.length, nonemptyAgentCount: oldAgents.length,
      unexpectedTypes, usersAreSourceSubsequence: subsequence(oldUsers, sourceUsers), agentsAreSourceSubsequence: subsequence(oldAgents, sourceAgents) },
    replacement: { messageCount: compact.messages.length, itemTypes: counts(newItems.map(item => item.type)),
      emptyUserCount: newItems.filter(item => item.type === 'user_message' && !item.content && !item.attachments?.length).length,
      toolStates: counts(newItems.filter(item => item.type === 'tool_call').map(item => item.state)),
      timestampCount: new Set(newItems.map(item => item.createdAt)).size, createdAt, updatedAt },
  };
  fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2));
  console.log(JSON.stringify({ note: 'Local artifacts only; review the audit before staging a migration.', replacementFile, auditFile, safeToReplace, replacementSha256: audit.hashes.replacementSha256,
    baselineFingerprint: audit.hashes.baselineFingerprint, source: audit.source, replacement: audit.replacement }, null, 2));
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).filter(Boolean).join('\n\n');
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
