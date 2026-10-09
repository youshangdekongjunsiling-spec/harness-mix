const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 30_000;

function isEligibleClaudeHistorySyncThread(thread) {
  return thread?.harnessId === 'claude' && thread.nativeHistorySnapshot?.source === 'claude'
    && thread.nativeHistorySync?.enabled === true;
}

function mayHaveForkedNativeHistorySync(thread) {
  return isEligibleClaudeHistorySyncThread(thread)
    && typeof thread.nativeHistorySnapshot.nativeSessionId === 'string'
    && thread.nativeHistorySnapshot.nativeSessionId !== thread.nativeSessionId;
}

function detachForkedNativeHistorySync(thread, checkedAt = Date.now()) {
  if (!mayHaveForkedNativeHistorySync(thread)) return false;
  const originSessionId = thread.nativeHistorySnapshot.nativeSessionId;
  const lineage = (thread.rewindHistory ?? []).findLast(entry => entry?.nativeSessionId === originSessionId);
  if (!lineage) return false;
  const sourceFile = thread.nativeHistorySync.sourceFile;
  if (typeof sourceFile === 'string') {
    const sourceSessionId = path.basename(sourceFile, path.extname(sourceFile));
    if (sourceSessionId !== originSessionId) return false;
    if (typeof lineage.nativeSessionFile !== 'string') lineage.nativeSessionFile = sourceFile;
    if (thread.nativeSessionFile === sourceFile) delete thread.nativeSessionFile;
  }
  thread.nativeHistorySync = { enabled: false, paused: false, status: 'detached',
    reason: 'native-session-forked', checkedAt };
  delete thread.nativeHistorySnapshot;
  return true;
}

function sourceIdentity(row) {
  const uuid = row?.uuid;
  if (typeof uuid !== 'string' || !uuid) return null;
  const parentUuid = row.parentUuid ?? row.parent_uuid ?? null;
  return `${uuid}\u0000${parentUuid == null ? '' : String(parentUuid)}`;
}

function hashPrefix(chain, count = chain.length) {
  const hash = crypto.createHash('sha256');
  for (let index = 0; index < count; index += 1) hash.update(chain[index]).update('\n');
  return hash.digest('hex');
}

function hashBytes(buffer, count = buffer.length) {
  return crypto.createHash('sha256').update(buffer.subarray(0, count)).digest('hex');
}

function checkpointFingerprint(checkpoint) {
  if (!checkpoint) return null;
  // Thread-level usage is refreshed independently of conversation history.
  // Exclude that derived item so a context-meter update cannot look like a
  // user edit and pause an otherwise append-only Claude sync.
  const items = (checkpoint.items ?? []).filter(item => !(item?.type === 'usage' && item.turnId == null));
  return crypto.createHash('sha256').update(JSON.stringify({ turns: checkpoint.turns ?? [],
    items })).digest('hex');
}

function branchChain(rows) {
  const identities = [];
  for (const row of rows ?? []) {
    const identity = sourceIdentity(row);
    if (identity) identities.push(identity);
  }
  return identities;
}

function parseCompleteJsonl(buffer) {
  const lastNewline = buffer.lastIndexOf(0x0a);
  const completeBytes = lastNewline < 0 ? 0 : lastNewline + 1;
  const text = buffer.subarray(0, completeBytes).toString('utf8');
  const rows = [];
  for (const [index, line] of text.split('\n').entries()) {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!value.trim()) continue;
    try { rows.push(JSON.parse(value)); }
    catch (error) {
      const failure = new Error(`invalid complete JSONL row ${index + 1}: ${error.message}`);
      failure.code = 'CLAUDE_HISTORY_INVALID_JSONL';
      throw failure;
    }
  }
  return { rows, completeBytes, hasPartialTail: completeBytes < buffer.length };
}

class ClaudeHistorySync {
  constructor({ runtime, readSnapshot, applySnapshot, discoverSources = null,
    onStatus = null, intervalMs = DEFAULT_INTERVAL_MS, discoveryIntervalMs = DEFAULT_DISCOVERY_INTERVAL_MS,
    stat = fs.stat, readFile = fs.readFile } = {}) {
    if (!runtime) throw new TypeError('runtime is required');
    if (typeof readSnapshot !== 'function') throw new TypeError('readSnapshot is required');
    if (typeof applySnapshot !== 'function') throw new TypeError('applySnapshot is required');
    this.runtime = runtime;
    this.readSnapshot = readSnapshot;
    this.applySnapshot = applySnapshot;
    this.discoverSources = typeof discoverSources === 'function' ? discoverSources : null;
    this.onStatus = onStatus;
    this.intervalMs = intervalMs;
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.nextDiscoveryAt = 0;
    this.stat = stat;
    this.readFile = readFile;
    this.timer = null;
    this.inFlight = null;
    this.stopped = true;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    for (const source of this.runtime.listClaudeHistorySyncSources()) {
      if (source.paused) this.runtime.announceClaudeHistorySyncStatus?.(source.threadId);
    }
    void this.tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => {});
  }

  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#poll().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async #poll() {
    await this.#discover();
    const sources = this.runtime.listClaudeHistorySyncSources();
    for (const source of sources) {
      if (this.stopped) break;
      await this.#pollSource(source).catch(error => {
        if (['CLAUDE_HISTORY_TARGET_CONFLICT', 'CLAUDE_HISTORY_INVALID_JSONL'].includes(error.code)) {
          return this.#pause(source, error.code, error.message);
        }
        return this.#status(source, 'error', error.message, { reason: error.code || 'sync-error' });
      });
    }
  }

  async #discover() {
    if (!this.discoverSources || Date.now() < this.nextDiscoveryAt) return;
    this.nextDiscoveryAt = Date.now() + this.discoveryIntervalMs;
    try {
      const knownNativeSessions = this.runtime.listImportedNativeSessions?.() ?? [];
      const candidates = await this.discoverSources({ knownNativeSessions });
      for (const candidate of candidates ?? []) {
        if (this.stopped) break;
        await this.runtime.importDiscoveredHistorySource(candidate).catch(() => {});
      }
    } catch {
      // Discovery is best-effort and retries on the next discovery interval.
      // Existing explicitly enabled sync sources must continue polling.
    }
  }

  async #pollSource(source) {
    if (!source?.enabled || source.paused || source.harnessId !== 'claude') return;
    if (!path.isAbsolute(source.sourceFile || '') || path.extname(source.sourceFile).toLowerCase() !== '.jsonl') {
      return this.#pause(source, 'invalid-source', 'Claude history source must be an absolute .jsonl file');
    }
    if (this.runtime.isClaudeHistorySyncBusy(source.threadId)) {
      return this.#status(source, 'waiting', 'Host thread is active', { reason: 'busy' });
    }

    const stat = await this.stat(source.sourceFile);
    if (!stat.isFile()) return this.#pause(source, 'invalid-source', 'Claude history source is not a file');
    const cursor = source.cursor ?? {};
    if (!Number.isFinite(cursor.appliedSize) || typeof cursor.sourcePrefixHash !== 'string'
      || !Number.isFinite(cursor.branchCount) || typeof cursor.prefixHash !== 'string'
      || typeof cursor.targetFingerprint !== 'string') {
      return this.#pause(source, 'baseline-missing', 'Claude history sync has no verified source and target baseline');
    }
    if (Number.isFinite(cursor.appliedSize) && stat.size < cursor.appliedSize) {
      return this.#pause(source, 'source-truncated', 'Claude history source was truncated');
    }
    if (cursor.observedSize === stat.size && cursor.observedMtimeMs === stat.mtimeMs) return;

    const buffer = await this.readFile(source.sourceFile);
    const parsed = parseCompleteJsonl(buffer);
    const observed = { observedSize: stat.size, observedMtimeMs: stat.mtimeMs };
    if (cursor.sourcePrefixHash && Number.isFinite(cursor.appliedSize)
      && hashBytes(buffer, cursor.appliedSize) !== cursor.sourcePrefixHash) {
      return this.#pause(source, 'source-rewritten', 'Claude history source no longer preserves the synchronized byte prefix');
    }
    if (parsed.completeBytes === (cursor.appliedSize ?? 0) && parsed.hasPartialTail) {
      return this.#status(source, 'waiting', 'Waiting for a complete JSONL row', { reason: 'partial-row', cursor: { ...cursor, ...observed } });
    }
    if (parsed.completeBytes === cursor.appliedSize && cursor.sourcePrefixHash
      && hashBytes(buffer, parsed.completeBytes) === cursor.sourcePrefixHash) {
      return this.#status(source, 'synced', null, { cursor: { ...cursor, ...observed } });
    }

    const target = this.runtime.prepareClaudeHistorySync(source.threadId);
    if (!target) return this.#pause(source, 'target-missing', 'Imported Host thread no longer exists');
    if (this.runtime.isClaudeHistorySyncBusy(source.threadId)) return this.#status(source, 'waiting', 'Host thread became active', { reason: 'busy' });
    if (checkpointFingerprint(target.checkpoint) !== cursor.targetFingerprint) {
      return this.#pause(source, 'host-history-changed', 'Host history changed after the last synchronized checkpoint');
    }
    const snapshot = await this.readSnapshot({ source, rows: parsed.rows, completeBytes: parsed.completeBytes,
      hasPartialTail: parsed.hasPartialTail, target });
    const branchRows = Array.isArray(snapshot?.branchRows) ? snapshot.branchRows : parsed.rows;
    const chain = branchChain(branchRows);
    const previousCount = cursor.branchCount ?? 0;
    if (chain.length < previousCount) return this.#pause(source, 'branch-truncated', 'Claude active branch became shorter');
    if (previousCount && cursor.prefixHash && hashPrefix(chain, previousCount) !== cursor.prefixHash) {
      return this.#pause(source, 'branch-changed', 'Claude active branch no longer preserves the synchronized prefix');
    }
    if (previousCount && chain.length === previousCount && parsed.completeBytes > (cursor.appliedSize ?? 0)) {
      return this.#status(source, parsed.hasPartialTail ? 'waiting' : 'synced', 'No new active-branch messages', {
        ...(parsed.hasPartialTail ? { reason: 'partial-row' } : {}),
        cursor: { ...cursor, ...observed, appliedSize: parsed.completeBytes,
          sourcePrefixHash: hashBytes(buffer, parsed.completeBytes) },
      });
    }

    const candidate = await this.applySnapshot({ source, snapshot, target });
    const nextCursor = { ...observed, appliedSize: parsed.completeBytes, branchCount: chain.length,
      prefixHash: hashPrefix(chain), sourcePrefixHash: hashBytes(buffer, parsed.completeBytes),
      leafUuid: branchRows.at(-1)?.uuid ?? null };
    await this.runtime.commitClaudeHistorySync(source.threadId, candidate, nextCursor);
    this.onStatus?.({ threadId: source.threadId, status: 'synced' });
  }

  async #pause(source, reason, detail) {
    await this.#status(source, 'paused', detail, { paused: true, reason });
  }

  async #status(source, status, detail, patch = {}) {
    await this.runtime.updateClaudeHistorySyncStatus(source.threadId, { status, detail: detail || undefined,
      checkedAt: Date.now(), ...patch });
    this.onStatus?.({ threadId: source.threadId, status, reason: patch.reason, detail: detail || undefined });
  }
}

module.exports = { ClaudeHistorySync, DEFAULT_DISCOVERY_INTERVAL_MS, DEFAULT_INTERVAL_MS, branchChain, checkpointFingerprint,
  detachForkedNativeHistorySync, hashBytes, hashPrefix, isEligibleClaudeHistorySyncThread,
  mayHaveForkedNativeHistorySync, parseCompleteJsonl };
