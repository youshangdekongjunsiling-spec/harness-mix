const { CoreSession } = require('../host/core-session');
const { projectClaudeHistory, selectClaudeBranch } = require('../host/claude-history');

function createClaudeHistorySyncOptions() {
  return {
    intervalMs: 5000,
    readSnapshot({ rows, target, completeBytes }) {
      const branchRows = selectClaudeBranch(rows);
      if (branchRows.some(row => (row.sessionId || row.session_id) !== target.thread.nativeSessionId)) {
        const error = new Error('Claude source session identity changed');
        error.code = 'CLAUDE_HISTORY_TARGET_CONFLICT';
        throw error;
      }
      return { branchRows, completeBytes };
    },
    applySnapshot({ snapshot, target }) {
      const messages = projectClaudeHistory(snapshot.branchRows);
      const thread = { ...target.thread, messages, tools: [] };
      delete thread.coreState;
      // Derived Host usage is not a source event; keep replay sequence deterministic.
      delete thread.usage;
      delete thread._storageStub;
      const timestamps = snapshot.branchRows.map(row => Date.parse(row.timestamp)).filter(Number.isFinite);
      if (!timestamps.length || !messages.length) {
        const error = new Error('Claude source has no complete dated conversation');
        error.code = 'CLAUDE_HISTORY_TARGET_CONFLICT';
        throw error;
      }
      thread.updatedAt = Math.max(...timestamps);
      const execution = new CoreSession();
      execution.threadCreated(thread);
      return { messages: thread.messages, checkpoint: execution.checkpoint(thread), updatedAt: thread.updatedAt,
        nativeHistorySnapshot: { version: 1, source: 'claude', nativeSessionId: thread.nativeSessionId,
          capturedAt: new Date().toISOString(), sourceMessageCount: snapshot.branchRows.length,
          sourceCompleteBytes: snapshot.completeBytes } };
    },
  };
}

module.exports = { createClaudeHistorySyncOptions };
