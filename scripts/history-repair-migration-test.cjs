const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPendingHistoryRepair, fingerprint } = require('../src/main/native/pending-history-repair');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mix-history-repair-'));

try {
  const dataRoot = path.join(root, 'data');
  const directory = path.join(dataRoot, 'mix-core');
  const records = path.join(directory, 'threads', 'records');
  const runtime = path.join(dataRoot, 'runtime');
  const threadId = crypto.randomUUID();
  fs.mkdirSync(records, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });

  const recordFile = path.join(records, `${threadId}.json`);
  const indexFile = path.join(directory, 'threads', 'index.json');
  const manifestFile = path.join(runtime, 'pending-history-repair.json');
  const replacementFile = path.join(root, 'replacement.json');
  const before = {
    id: threadId,
    harnessId: 'claude',
    nativeSessionId: 'synthetic-native-session',
    title: 'Keep this title',
    archived: true,
    status: 'error',
    error: 'synthetic old error',
    errorKind: 'unknown',
    messages: [{ role: 'user', text: 'synthetic original' }],
    coreState: { thread: { id: threadId }, turns: [], items: [] },
    createdAt: 1,
    updatedAt: 2,
  };
  const replacement = {
    ...before,
    title: 'Replacement title must not win',
    archived: false,
    messages: [{ role: 'user', text: 'synthetic repaired' }],
    updatedAt: 3,
    status: 'ready',
  };
  delete replacement.error;
  delete replacement.errorKind;
  write(recordFile, before);
  write(indexFile, { schemaVersion: 3, threads: [{ id: threadId, title: before.title, archived: true, status: 'error' }] });
  write(replacementFile, replacement);
  const manifest = {
    version: 1,
    dataDirectory: path.resolve(directory),
    threadId,
    replacementFile: path.resolve(replacementFile),
    replacementSha256: hash(replacementFile),
    expectedFingerprint: fingerprint(before),
    backupDirectory: path.resolve(root, 'backup'),
  };
  write(manifestFile, manifest);

  assert.equal(applyPendingHistoryRepair(directory).status, 'applied');
  const actual = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(actual.title, before.title);
  assert.equal(actual.archived, true);
  assert.equal(actual.status, 'ready');
  assert.equal(Object.hasOwn(actual, 'error'), false);
  assert.equal(Object.hasOwn(actual, 'errorKind'), false);
  assert.equal(actual.messages[0].text, 'synthetic repaired');
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).threads[0].updatedAt, 3);
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).threads[0].status, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'backup', 'record.before.json'), 'utf8')).messages[0].text, 'synthetic original');
  assert.equal(applyPendingHistoryRepair(directory).status, 'none');

  // Legacy replacement files without an explicit status retain the old status/error behavior.
  const legacyReplacementFile = path.join(root, 'legacy-replacement.json');
  const legacyReplacement = { ...replacement };
  delete legacyReplacement.status;
  write(recordFile, before);
  write(indexFile, { schemaVersion: 3, threads: [{ id: threadId, title: before.title, archived: true, status: 'error' }] });
  write(legacyReplacementFile, legacyReplacement);
  write(manifestFile, { ...manifest, replacementFile: legacyReplacementFile,
    replacementSha256: hash(legacyReplacementFile), backupDirectory: path.resolve(root, 'legacy-backup') });
  assert.equal(applyPendingHistoryRepair(directory).status, 'applied');
  const legacyActual = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(legacyActual.status, 'error');
  assert.equal(legacyActual.error, before.error);
  assert.equal(legacyActual.errorKind, before.errorKind);
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).threads[0].status, 'error');

  // A changed live transcript is never overwritten.
  write(recordFile, { ...before, messages: [{ role: 'user', text: 'synthetic live change' }] });
  write(manifestFile, { ...manifest, backupDirectory: path.resolve(root, 'conflict-backup') });
  const unchanged = fs.readFileSync(recordFile, 'utf8');
  assert.throws(() => applyPendingHistoryRepair(directory), /History changed/);
  assert.equal(fs.readFileSync(recordFile, 'utf8'), unchanged);

  // Recover a record-write/index-write interruption without replacing the backup.
  write(recordFile, replacement);
  write(manifestFile, manifest);
  assert.equal(applyPendingHistoryRepair(directory).status, 'applied');
  console.log('history repair migration tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
