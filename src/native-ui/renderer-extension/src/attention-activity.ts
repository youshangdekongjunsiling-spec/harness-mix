import type { AttentionActivity, AttentionThread } from "./attention-types.js";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type SendRequest = (method: string, params: unknown) => Promise<unknown> | unknown;

const STORAGE_KEY = "harnessmix.attention.activity.v1";
const MAX_ENTRIES = 512;
const MAX_HISTORY_READS = 8;
const MAX_CONCURRENCY = 2;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PATH_LENGTH = 16_384;
const ACTIVE_TTL_MS = 30_000;
const IDLE_TTL_MS = 60_000;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Accept local absolute paths only. UNC paths and URL-shaped values are intentionally excluded. */
export function localAbsolutePath(value: unknown): string | undefined {
  const path = text(value);
  if (!path || path.length > MAX_PATH_LENGTH || /[\0-\x1f]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return undefined;
  if (/^[\\/]{2}/.test(path)) return undefined;
  if (/^[a-z]:[\\/]/i.test(path) || /^\/(?!\/)/.test(path)) return path;
  return undefined;
}

type StoredActivity = AttentionActivity & { threadId: string };
type Check = { updatedAt: number | null; checkedAt: number };

export interface AttentionActivityInspection {
  attempted: number;
  incomplete: boolean;
  unavailable: boolean;
}

export interface AttentionActivityTracker {
  decorate(thread: AttentionThread): AttentionThread;
  observeNotification(notification: unknown): boolean;
  inspect(threads: readonly AttentionThread[], sendRequest: SendRequest, projectId?: string, projectRoots?: readonly string[]): Promise<AttentionActivityInspection>;
  cwdPaths(threads: readonly AttentionThread[], projectId?: string, max?: number, projectRoots?: readonly string[]): string[];
}

function activityFromItem(value: unknown, observedAt: number): AttentionActivity | undefined {
  const item = record(value);
  if (!item || text(item.type) !== "commandExecution") return undefined;
  const cwd = localAbsolutePath(item.cwd);
  if (!cwd) return undefined;
  const itemId = text(item.id);
  return { cwd, observedAt, source: "command", ...(itemId ? { itemId } : {}) };
}

function latestHistoryActivity(value: unknown, observedAt: number): AttentionActivity | undefined {
  const response = record(value);
  const thread = record(response?.thread) ?? response;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  let latest: AttentionActivity | undefined;
  for (const turnValue of turns) {
    const turn = record(turnValue);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) latest = activityFromItem(item, observedAt) ?? latest;
  }
  return latest;
}

function defaultStorage(): StorageLike | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

export function createAttentionActivityTracker(options: { storage?: StorageLike | null; now?: () => number } = {}): AttentionActivityTracker {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? Date.now;
  const activities = new Map<string, AttentionActivity>();
  const revisions = new Map<string, number>();
  const checks = new Map<string, Check>();
  const inFlight = new Map<string, number>();

  const forgetAuxiliary = (threadId: string): void => {
    checks.delete(threadId);
    if (!inFlight.has(threadId)) revisions.delete(threadId);
  };

  const trim = (): void => {
    const cutoff = now() - MAX_AGE_MS;
    for (const [threadId, activity] of activities) {
      if (activity.observedAt < cutoff) {
        activities.delete(threadId);
        forgetAuxiliary(threadId);
      }
    }
    while (activities.size > MAX_ENTRIES) {
      const threadId = activities.keys().next().value!;
      activities.delete(threadId);
      forgetAuxiliary(threadId);
    }
    while (checks.size > MAX_ENTRIES) {
      const threadId = checks.keys().next().value!;
      checks.delete(threadId);
      if (!activities.has(threadId) && !inFlight.has(threadId)) revisions.delete(threadId);
    }
    while (revisions.size > MAX_ENTRIES + inFlight.size) {
      const threadId = [...revisions.keys()].find(id => !inFlight.has(id));
      if (!threadId) break;
      revisions.delete(threadId);
    }
  };
  const persist = (): void => {
    trim();
    if (!storage) return;
    const rows: StoredActivity[] = [...activities].map(([threadId, activity]) => ({ threadId, ...activity }));
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, rows })); } catch { /* memory-only tracking remains useful */ }
  };
  if (storage) {
    try {
      const parsed = record(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      for (const value of rows.slice(-MAX_ENTRIES)) {
        const row = record(value);
        const threadId = text(row?.threadId);
        const cwd = localAbsolutePath(row?.cwd);
        const observedAt = typeof row?.observedAt === "number" && Number.isFinite(row.observedAt) ? row.observedAt : undefined;
        const source = row?.source === "command" || row?.source === "worktree" ? row.source : undefined;
        const itemId = text(row?.itemId);
        if (threadId && cwd && observedAt !== undefined && source) activities.set(threadId, { cwd, observedAt, source, ...(itemId ? { itemId } : {}) });
      }
      trim();
    } catch { /* ignore corrupt or inaccessible persisted state */ }
  }

  const setActivity = (threadId: string, activity: AttentionActivity, expectedRevision?: number): boolean => {
    const revision = revisions.get(threadId) ?? 0;
    if (expectedRevision !== undefined && revision !== expectedRevision) return false;
    const previous = activities.get(threadId);
    if (previous && previous.observedAt > activity.observedAt) return false;
    activities.delete(threadId);
    activities.set(threadId, activity);
    revisions.set(threadId, revision + 1);
    persist();
    return true;
  };
  const seedWorktree = (thread: AttentionThread): void => {
    const threadId = String(thread.id);
    const previous = activities.get(threadId);
    if (thread.workspace?.mode !== "worktree") {
      if (previous?.source === "worktree") {
        activities.delete(threadId);
        forgetAuxiliary(threadId);
        persist();
      }
      return;
    }
    if (thread.source !== "harnessmix") return;
    const cwd = localAbsolutePath(thread.workspace?.root);
    if (!cwd) {
      if (previous?.source === "worktree") {
        activities.delete(threadId);
        forgetAuxiliary(threadId);
        persist();
      }
      return;
    }
    if (previous?.source === "command" || previous?.cwd === cwd) return;
    setActivity(threadId, {
      cwd,
      observedAt: Math.max(thread.updatedAt ?? now(), (previous?.observedAt ?? 0) + 1),
      source: "worktree",
    });
  };
  const inProject = (thread: AttentionThread, projectId?: string, projectRoots: readonly string[] = []): boolean => {
    if (projectId && thread.projectId === projectId) return true;
    const cwd = localAbsolutePath(activities.get(String(thread.id))?.cwd) ?? localAbsolutePath(thread.cwd);
    if (!cwd) return false;
    const comparable = cwd.replaceAll("\\", "/").toLocaleLowerCase().replace(/\/$/, "");
    return projectRoots.some(value => {
      const root = localAbsolutePath(value)?.replaceAll("\\", "/").toLocaleLowerCase().replace(/\/$/, "");
      return !!root && (comparable === root || comparable.startsWith(`${root}/`));
    });
  };
  const ranked = (threads: readonly AttentionThread[], projectId?: string, projectRoots?: readonly string[]): AttentionThread[] => [...threads].sort((a, b) => {
    const project = Number(inProject(b, projectId, projectRoots)) - Number(inProject(a, projectId, projectRoots));
    if (project) return project;
    const active = Number(b.status === "running") - Number(a.status === "running");
    if (active) return active;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });

  return {
    decorate(thread) {
      seedWorktree(thread);
      const activity = activities.get(String(thread.id));
      return activity ? { ...thread, activity } : thread;
    },
    observeNotification(notification) {
      const row = record(notification);
      const method = text(row?.method);
      if (method !== "item/started" && method !== "item/completed") return false;
      const params = record(row?.params) ?? row;
      const threadId = text(params?.threadId) ?? text(params?.conversationId);
      const activity = activityFromItem(params?.item, now());
      return !!threadId && !!activity && setActivity(threadId, activity);
    },
    async inspect(threads, sendRequest, projectId, projectRoots) {
      const candidates = [...threads.filter(thread => thread.source === "native")].sort((a, b) => {
        const project = Number(inProject(b, projectId, projectRoots)) - Number(inProject(a, projectId, projectRoots));
        if (project) return project;
        const unseen = Number(!checks.has(String(b.id))) - Number(!checks.has(String(a.id)));
        if (unseen) return unseen;
        const active = Number(b.status === "running" || b.status === "waiting") - Number(a.status === "running" || a.status === "waiting");
        if (active) return active;
        const checked = (checks.get(String(a.id))?.checkedAt ?? 0) - (checks.get(String(b.id))?.checkedAt ?? 0);
        return checked || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      });
      const due = candidates.filter(thread => {
        const checked = checks.get(String(thread.id));
        const ttl = thread.status === "running" || thread.status === "waiting" ? ACTIVE_TTL_MS : IDLE_TTL_MS;
        return !checked || checked.updatedAt !== thread.updatedAt || now() - checked.checkedAt >= ttl;
      });
      const selected = due.slice(0, MAX_HISTORY_READS);
      let unavailable = false;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < selected.length) {
          const thread = selected[cursor++];
          if (!thread) return;
          const threadId = String(thread.id);
          const revision = revisions.get(threadId) ?? 0;
          inFlight.set(threadId, (inFlight.get(threadId) ?? 0) + 1);
          try {
            const result = await sendRequest("thread/read", { threadId, includeTurns: true });
            const activity = latestHistoryActivity(result, now());
            if (activity) setActivity(threadId, activity, revision);
          } catch { unavailable = true; }
          const remainingReads = (inFlight.get(threadId) ?? 1) - 1;
          if (remainingReads > 0) inFlight.set(threadId, remainingReads);
          else inFlight.delete(threadId);
          if (!activities.has(threadId)) revisions.delete(threadId);
          checks.delete(threadId);
          checks.set(threadId, { updatedAt: thread.updatedAt, checkedAt: now() });
          trim();
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, selected.length) }, () => worker()));
      return { attempted: selected.length, incomplete: due.length > selected.length, unavailable };
    },
    cwdPaths(threads, projectId, max = 32, projectRoots) {
      const paths: string[] = [];
      const seen = new Set<string>();
      const add = (value: unknown): void => {
        const path = localAbsolutePath(value);
        const key = path && /^[a-z]:[\\/]/i.test(path)
          ? path.replaceAll("/", "\\").toLocaleLowerCase()
          : path;
        if (!path || !key || seen.has(key) || paths.length >= max) return;
        seen.add(key);
        paths.push(path);
      };
      for (const thread of ranked(threads, projectId, projectRoots)) {
        seedWorktree(thread);
        add(activities.get(String(thread.id))?.cwd);
        add(thread.cwd);
      }
      return paths;
    },
  };
}
