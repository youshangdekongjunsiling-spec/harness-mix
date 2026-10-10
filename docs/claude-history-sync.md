# Claude history synchronization

Harness Mix can follow an imported Claude Code JSONL session as an explicitly enabled, one-way history source. The Host polls enabled sources every five seconds and projects newly completed source records into the existing imported thread. It never writes to the Claude file or starts Claude Code. By default it does not discover sessions automatically; the global opt-in described below adds shallow local discovery.

## Optional automatic discovery

Set **HARNESSMIX_CLAUDE_HISTORY_DISCOVERY=1**, or save the corresponding boolean setting as true, to scan direct JSONL files below Claude's local projects directories at startup and about every 30 seconds. The scan reads directory entries and file metadata first. It reads a transcript only when its native session identity is not already imported and caches unchanged invalid candidates by size and modification time.

Automatic discovery skips empty files, partial JSONL tails, nested subagent files, sidechain-only histories, mixed session identities, missing working directories, and conversations that do not yet contain both a real user input and an assistant record. A file that grows or changes is reconsidered. Imported threads use the same projector, append-only cursor checks, persistence, and sidebar notification path as manual imports.

Native session identity prevents duplicate import across scans and restarts. Archived threads remain managed and are not recreated. Deletion writes a native identity tombstone so a deleted automatically or manually imported session stays deleted. Legacy deletion markers created before native identities were recorded can only suppress the original Host thread ID.

## Runtime integration

Pass the production adapter when constructing the Host Runtime:

```js
const { HostRuntime } = require('../host/runtime');
const { createClaudeHistorySyncOptions } = require('./claude-sync-options');

const runtime = new HostRuntime({
  dataDirectory,
  claudeHistorySync: createClaudeHistorySyncOptions(),
});
```

The caller supplies `dataDirectory`; no user-specific path belongs in source code. A thread is eligible only when it is an imported Claude thread with `nativeHistorySnapshot.source === 'claude'` and the following persisted opt-in metadata:

```js
thread.nativeHistorySync = {
  enabled: true,
  paused: false,
  status: 'synced',
  sourceFile: absoluteClaudeJsonlPath,
  cursor: {
    observedSize,
    observedMtimeMs,
    appliedSize,
    sourcePrefixHash,
    branchCount,
    prefixHash,
    leafUuid,
    targetFingerprint,
  },
};
```

This record is a migration artifact, not a hand-written preference. `sourcePrefixHash` authenticates the complete JSONL byte prefix through `appliedSize`. `prefixHash` authenticates the selected Claude UUID/parent chain. `targetFingerprint` authenticates the Core turns and items produced from the same snapshot. The helpers exported by `src/main/host/claude-history-sync.js` calculate these values.

`thread-store.js` retains `nativeHistorySnapshot` and `nativeHistorySync` in the lazy index so startup can find enabled sources without hydrating every conversation. Full cursor changes are persisted through the existing Runtime and `ThreadStore` save queue.

## Append and conflict rules

Unchanged size and modification time stop the poll before any file read or history rebuild. A trailing JSONL fragment is held until a later poll completes the line. Queue or system rows that do not change the active branch advance the byte cursor without rebuilding the target.

Synchronization pauses when any append-only invariant fails:

- the source is truncated or its already synchronized byte prefix changes;
- the selected UUID/parent branch no longer retains the synchronized prefix;
- the Host checkpoint changes because the imported thread was continued locally;
- a candidate would reorder turns or remove an existing turn or item;
- the source session identity no longer matches the imported native session.

Opening, sending, switching, and running threads are reported as waiting and skipped. A successful candidate can update an existing tail turn, such as completing a tool result or native stop state, and can append new stable turns. The Runtime rechecks the target fingerprint immediately before Core restore to close the projection race.

A paused source stays paused until a deliberate migration or repair verifies a new common baseline and clears `paused`. Original source and target records remain intact.

## Migration and snapshot limits

Enable synchronization only after an importer has captured an exact complete-line source snapshot and built the replacement Core checkpoint from that snapshot. Seed all cursor hashes and counts in the same atomic repair that installs the imported record. Set observed file metadata to sentinel values when the first runtime poll must compare the live file with the frozen prefix.

The frozen snapshot must be a byte-for-byte prefix of the live JSONL file. A reformatted, compacted, rewritten, or different-branch copy cannot be treated as the same source even if visible text looks equivalent. This mechanism follows one verified main Claude branch; it does not merge branches, reconcile two-way edits, or infer a baseline from an unverified existing conversation.

## Validation of this fork

The fixes were developed against the `v0.4.0` source tag and checked on Windows with Codex Desktop `26.1002.7124.0`. The user confirmed that imported history could be opened and that the repaired display and synchronization worked after restarting. This is a local compatibility result, not a claim of parity on every Desktop version.

Reproducible checks:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm run typecheck:native-ui
npm run test:core-all
npm run test:claude-history
npx vitest run src/native-ui/desktop-control/test/cdp-client.test.ts src/native-ui/desktop-control/test/renderer-draft-prewarm-policy.test.ts
node scripts/native-protocol-test.cjs
```

The upstream `v0.4.0` lockfile is stale relative to its optional native package versions and workspace declarations, so `npm ci` fails before running tests. The validation checkout used `npm install --ignore-scripts --package-lock=false` without publishing an unrelated lockfile rewrite. Build JavaScript bundles before using the source checkout; generated `output/` and `dist/` files are intentionally not committed. Native sidecar isolation was also exercised with a fresh data directory and unchanged `0.4.0` native binaries.

Reading and synchronizing local Claude transcripts does not require a Claude model request. Continuing a conversation does require working authentication in the CLI/SDK environment used by the adapter; authentication errors are separate from transcript import.

## Original branches and diagnostic conversations

Automatic discovery links a retained Claude rewind origin to the Host conversation that continued on a new native session. The imported origin is named `[原始分支] <continued conversation title>` and stores `nativeHistoryLineage` in both its record and lazy index. Its native transcript remains intact.

An origin with no transcript activity newer than the rewind is initially archived. If it later synchronizes a new turn, an automatically archived origin returns to the normal list. Explicit archive/unarchive actions clear this automatic behavior, so synchronization respects the user's choice. An origin already containing newer work stays visible when first discovered. Existing imported records are not automatically renamed or re-archived on every scan.

Archived imports and background synchronization do not emit sidebar `thread/started` notifications. History can still synchronize while archived.

Discovery excludes only a standalone two-message diagnostic conversation: the exact prompt `Reply exactly HARNESS_MIX_HEALTH_OK. Do not use tools or modify files.` followed by the exact text reply `HARNESS_MIX_HEALTH_OK`, with no tool or non-text content. Conversations mentioning that marker, containing tools, or continuing with additional user messages remain eligible for import. A changed transcript is reconsidered on the next discovery scan.
