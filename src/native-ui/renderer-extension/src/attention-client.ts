import { type AttentionData, type AttentionEvent, type AttentionProject, type AttentionRepository, type AttentionThread, type AttentionThreadStatus } from "./attention-types.js";
import { createAttentionActivityTracker } from "./attention-activity.js";

export const NATIVE_THREAD_LIST_METHOD = "thread/list";
export const NATIVE_THREAD_READ_METHOD = "thread/read";
export const ATTENTION_SNAPSHOT_METHOD = "harnessmix/attention/snapshot";

type SendRequest = (method: string, params: unknown) => Promise<unknown> | unknown;
type Subscribe = (methods: string | readonly string[], listener: (notification: unknown) => void) => () => void;

export interface AttentionClient {
  load(options?: { includeGit?: boolean; projectId?: string }): Promise<AttentionData>;
  subscribe(listener: (event: AttentionEvent | undefined) => void): () => void;
  dispose(): void;
}

const MAX_THREAD_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_CWDS = 32;
const MAX_EVENT_CACHE = 512;
const TERMINAL_METHODS = [
  "thread/status/changed",
  "thread/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "harnessmix/thread/status/changed",
] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Native app-server timestamps are epoch seconds; Host snapshots are milliseconds. */
const timestamp = (value: unknown, source: "native" | "harnessmix" = "harnessmix"): number | undefined => {
  const valueNumber = number(value);
  if (valueNumber === undefined) return undefined;
  return source === "native" && valueNumber < 100_000_000_000 ? Math.round(valueNumber * 1000) : valueNumber;
};

function nativeStatus(value: unknown): AttentionThreadStatus | undefined {
  const direct = text(value);
  if (direct) {
    if (direct === "waitingOnApproval" || direct === "waitingOnUserInput") return "waiting";
    if (direct === "systemError") return "error";
    if (direct === "notLoaded") return "unknown";
    return statusOf(direct);
  }
  const object = record(value);
  if (!object) return undefined;
  const type = text(object.type);
  if (type === "idle") return "idle";
  if (type === "waitingOnApproval" || type === "waitingOnUserInput") return "waiting";
  if (type === "systemError") return "error";
  if (type === "notLoaded") return "unknown";
  if (type !== "active") return "unknown";
  const flags = Array.isArray(object.activeFlags) ? object.activeFlags.map(text).filter((v): v is string => !!v) : [];
  return flags.some(flag => /wait|approval|question|input/i.test(flag)) ? "waiting" : "running";
}

function statusOf(value: unknown): AttentionThreadStatus {
  const status = text(value);
  if (status === "running" || status === "waiting" || status === "completed" || status === "error" || status === "idle" || status === "interrupted") return status;
  return "unknown";
}

function eventOf(row: Record<string, unknown>, id: string, source: "native" | "harnessmix"): AttentionEvent | undefined {
  const event = record(row.event);
  const kind = text(event?.kind);
  const at = timestamp(event?.at, source);
  const eventId = text(event?.id);
  return eventId && at !== undefined && (kind === "completed" || kind === "waiting" || kind === "error")
    ? { id: eventId, threadId: id, kind, at }
    : undefined;
}

function nativeTurn(row: Record<string, unknown>, threadId: string): { status?: AttentionThreadStatus; turnId?: string; event?: AttentionEvent } {
  const turns = Array.isArray(row.turns) ? row.turns.map(record).filter((v): v is Record<string, unknown> => !!v) : [];
  const turn = turns.at(-1);
  if (!turn) return {};
  const turnId = text(turn.id);
  const rawStatus = text(turn.status);
  const status = rawStatus === "completed" ? "completed"
    : rawStatus === "error" || rawStatus === "failed" ? "error"
      : rawStatus === "waiting_interaction" ? "waiting"
        : rawStatus === "inProgress" || rawStatus === "running" ? "running"
          : rawStatus === "interrupted" || rawStatus === "cancelled" ? "interrupted" : undefined;
  if (!status) return turnId ? { turnId } : {};
  const at = timestamp(turn.completedAt ?? turn.updatedAt ?? turn.startedAt, "native");
  const kind: AttentionEvent["kind"] | undefined = status === "waiting" || status === "completed" || status === "error" ? status : undefined;
  const event = kind && at !== undefined
    ? { id: `${threadId}:${turnId ?? "turn"}:${kind}`, threadId, kind, at }
    : undefined;
  return { ...(status ? { status } : {}), ...(turnId ? { turnId } : {}), ...(event ? { event } : {}) };
}

function normalizeThread(value: unknown, source: "native" | "harnessmix"): AttentionThread | null {
  const row = record(value);
  const id = text(row?.id) ?? text(row?.threadId);
  if (!row || !id) return null;
  const git = record(row.gitInfo);
  const workspace = record(row.workspace);
  const nativeTurnInfo = source === "native" ? nativeTurn(row, id) : {};
  const liveStatus = source === "native" ? nativeStatus(row.status ?? row.state) : undefined;
  // Active native status is current evidence. A historical terminal Turn must
  // not hide a running/waiting thread or manufacture a stale terminal event.
  const status = source === "native"
    ? (liveStatus === "running" || liveStatus === "waiting" || liveStatus === "error" || liveStatus === "unknown"
      ? liveStatus : liveStatus === "idle" ? nativeTurnInfo.status ?? "idle" : nativeTurnInfo.status ?? "unknown")
    : statusOf(row.status ?? row.state);
  const event = eventOf(row, id, source)
    ?? (status === nativeTurnInfo.status && status !== "running" ? nativeTurnInfo.event : undefined);
  const preview = text(row.preview);
  const title = text(row.title) ?? text(row.name) ?? preview ?? "未命名任务";
  const explicitTurnId = text(row.turnId) ?? text(row.turn_id);
  const historicalTerminal = nativeTurnInfo.status === "completed" || nativeTurnInfo.status === "error" || nativeTurnInfo.status === "interrupted";
  const turnId = explicitTurnId ?? (((liveStatus === "running" || liveStatus === "waiting") && historicalTerminal)
    ? undefined : nativeTurnInfo.turnId);
  return {
    id,
    title,
    harnessId: text(row.harnessId) ?? (source === "native" ? "codex" : "unknown"),
    cwd: text(row.cwd) ?? text(row.originalCwd) ?? null,
    ...(text(row.originalCwd) ? { originalCwd: text(row.originalCwd) } : {}),
    projectId: text(row.projectId) ?? null,
    updatedAt: timestamp(row.updatedAt ?? row.updated_at, source) ?? null,
    status,
    ...(turnId ? { turnId } : {}),
    ...(event ? { event } : {}),
    ...(git ? { gitInfo: { ...(text(git.branch) ? { branch: text(git.branch) } : {}), ...(text(git.sha) ? { sha: text(git.sha) } : {}) } } : {}),
    ...(workspace ? { workspace: { ...(text(workspace.mode) ? { mode: text(workspace.mode) } : {}), ...(text(workspace.root) ? { root: text(workspace.root) } : {}), ...(text(workspace.branch) ? { branch: text(workspace.branch) } : {}), ...(text(workspace.baseCommit) ? { baseCommit: text(workspace.baseCommit) } : {}) } } : {}),
    source,
    ...(preview ? { preview } : {}),
  };
}

function normalizeProject(value: unknown): AttentionProject | null {
  const row = record(value);
  const id = text(row?.id);
  if (!row || !id) return null;
  const rootPaths = Array.isArray(row.rootPaths) ? row.rootPaths.map(text).filter((v): v is string => !!v) : [];
  return { id, name: text(row.name) ?? id, rootPaths };
}

function normalizeRepository(value: unknown): AttentionRepository | null {
  const row = record(value);
  const id = text(row?.id);
  const root = text(row?.root);
  if (!row || !id || !root) return null;
  const rawRepoError = text(row.error);
  const rawReason = text(row.reason);
  const legacyNotGit = !!rawRepoError && /not a git repository/i.test(rawRepoError);
  const reason = legacyNotGit ? "not-git" : rawReason === "not-git" || rawReason === "missing-path" || rawReason === "permission-denied" || rawReason === "timeout" || rawReason === "git-error"
    ? rawReason : undefined;
  const repoError = legacyNotGit ? undefined : rawRepoError;
  const arr = <T>(key: string): T[] => Array.isArray(row[key]) ? row[key] as T[] : [];
  return {
    id, root,
    paths: arr<unknown>("paths").map(text).filter((v): v is string => !!v),
    available: row.available === true,
    ...(reason ? { reason } : {}),
    ...(repoError ? { error: repoError } : {}),
    defaultBranch: text(row.defaultBranch) ?? null,
    commits: arr<unknown>("commits").map(record).filter((v): v is Record<string, unknown> => !!v).map(commit => ({ hash: text(commit.hash) ?? "", parents: Array.isArray(commit.parents) ? commit.parents.map(text).filter((v): v is string => !!v) : [], subject: text(commit.subject) ?? "", timestamp: number(commit.timestamp) ?? 0 })).filter(commit => commit.hash),
    branches: arr<unknown>("branches").map(record).filter((v): v is Record<string, unknown> => !!v).map(branch => ({ name: text(branch.name) ?? "", head: text(branch.head) ?? "", merged: typeof branch.merged === "boolean" ? branch.merged : null })).filter(branch => branch.name && branch.head),
    worktrees: arr<unknown>("worktrees").map(record).filter((v): v is Record<string, unknown> => !!v).map(worktree => ({ path: text(worktree.path) ?? "", branch: text(worktree.branch) ?? null, head: text(worktree.head) ?? null, dirty: number(worktree.dirty) ?? null, detached: worktree.detached === true })).filter(worktree => worktree.path),
    truncated: row.truncated === true,
  };
}

function mergeThreads(native: AttentionThread[], managed: AttentionThread[]): AttentionThread[] {
  const byId = new Map(native.map(thread => [String(thread.id), thread]));
  for (const thread of managed) byId.set(String(thread.id), thread);
  return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function notificationEvent(value: unknown): AttentionEvent | undefined {
  const row = record(value);
  const params = record(row?.params) ?? row;
  const method = text(row?.method);
  const threadId = text(params?.threadId) ?? text(params?.conversationId);
  if (!threadId) return undefined;
  if (method === "turn/completed") {
    const turn = record(params?.turn);
    const turnId = text(turn?.id) ?? text(params?.turnId) ?? "turn";
    const turnStatus = text(turn?.status);
    const kind = turnStatus === "completed" ? "completed" : turnStatus === "error" || turnStatus === "failed" ? "error" : undefined;
    if (!kind) return undefined;
    const at = timestamp(turn?.completedAt ?? turn?.updatedAt, "native") ?? timestamp(params?.completedAtMs) ?? Date.now();
    return { id: `${threadId}:${turnId}:${kind}`, threadId, kind, at };
  }
  if (method === "thread/status/changed" || method === "harnessmix/thread/status/changed" || method === "turn/started") return undefined;
  const id = text(params?.eventId) ?? text(params?.id);
  const kind = text(params?.kind) ?? text(params?.status);
  const at = timestamp(params?.at) ?? timestamp(params?.timestamp) ?? Date.now();
  if (!id || (kind !== "completed" && kind !== "waiting" && kind !== "error")) return undefined;
  return { id, threadId, kind, at };
}

export function createAttentionClient(sendRequest: SendRequest, subscribe?: Subscribe): AttentionClient {
  const activity = createAttentionActivityTracker();
  const listeners = new Set<(event: AttentionEvent | undefined) => void>();
  let cachedNative: AttentionThread[] = [];
  const cachedNativeEvents = new Map<string, AttentionEvent>();
  type NativeLifecycle = { turnId?: string; phase?: AttentionThreadStatus; waitingSequence: number };
  const nativeLifecycle = new Map<string, NativeLifecycle>();
  let cachedManaged: AttentionThread[] = [];
  let cachedProjects: AttentionProject[] = [];
  let cachedRepositories: AttentionRepository[] = [];
  let cachedGeneratedAt = 0;
  let detach: (() => void) | undefined;
  const trimCache = <T>(cache: Map<string, T>): void => {
    while (cache.size > MAX_EVENT_CACHE) cache.delete(cache.keys().next().value!);
  };
  const lifecycleFor = (threadId: string): NativeLifecycle => {
    let state = nativeLifecycle.get(threadId);
    if (!state) {
      state = { waitingSequence: 0 };
      nativeLifecycle.set(threadId, state);
      trimCache(nativeLifecycle);
    } else {
      nativeLifecycle.delete(threadId);
      nativeLifecycle.set(threadId, state);
    }
    return state;
  };
  const retainEvent = (event: AttentionEvent): AttentionEvent => {
    const previous = cachedNativeEvents.get(event.threadId);
    if (previous && previous.at > event.at) return previous;
    cachedNativeEvents.delete(event.threadId);
    cachedNativeEvents.set(event.threadId, event);
    trimCache(cachedNativeEvents);
    return event;
  };
  const clearWaiting = (threadId: string): void => {
    if (cachedNativeEvents.get(threadId)?.kind === "waiting") cachedNativeEvents.delete(threadId);
  };
  const reconcileNative = (thread: AttentionThread): AttentionThread => {
    const threadId = String(thread.id);
    const state = lifecycleFor(threadId);
    if (thread.turnId && state.turnId !== thread.turnId) {
      const cached = cachedNativeEvents.get(threadId);
      const rowIsActive = thread.status === "running" || thread.status === "waiting";
      const knownTurnIsActive = state.phase === "running" || state.phase === "waiting";
      const cachedIsNewer = !!cached && (!thread.event || cached.at >= thread.event.at);
      // A live active row is direct evidence of a newly observed current Turn.
      // Terminal rows can lag notifications, so never let an older/different
      // historical Turn replace a notification-proven current Turn or event.
      if (!rowIsActive && state.turnId && (knownTurnIsActive || cachedIsNewer)) {
        const status = knownTurnIsActive ? state.phase! : cached?.kind ?? thread.status;
        return {
          ...thread,
          status,
          turnId: state.turnId,
          ...(cached ? { event: cached } : { event: undefined }),
        };
      }
      state.turnId = thread.turnId;
      state.waitingSequence = 0;
      delete state.phase;
      cachedNativeEvents.delete(threadId);
    }
    let event = thread.event;
    if (thread.status === "waiting") {
      if (state.phase !== "waiting") {
        state.waitingSequence += 1;
        event = retainEvent({
          id: `${threadId}:${state.turnId ?? thread.turnId ?? "turn"}:waiting:${state.waitingSequence}`,
          threadId,
          kind: "waiting",
          at: thread.event?.at ?? thread.updatedAt ?? Date.now(),
        });
      } else event = cachedNativeEvents.get(threadId) ?? event;
      state.phase = "waiting";
    } else if (thread.status === "running") {
      state.phase = "running";
      clearWaiting(threadId);
      event = undefined;
    } else if (thread.status === "idle" || thread.status === "unknown" || thread.status === "interrupted") {
      state.phase = thread.status;
      clearWaiting(threadId);
      const cached = cachedNativeEvents.get(threadId);
      if (cached?.kind === "waiting") event = undefined;
      else if (cached && (!event || cached.at >= event.at)) event = cached;
      else if (event) event = retainEvent(event);
    } else {
      state.phase = thread.status;
      if (thread.status === "error" && !event) {
        event = { id: `${threadId}:${state.turnId ?? thread.turnId ?? "thread"}:error:systemError`, threadId, kind: "error",
          at: thread.updatedAt ?? Date.now() };
      }
      if (event) event = retainEvent(event);
      const cached = cachedNativeEvents.get(threadId);
      if (cached && (!event || cached.at >= event.at)) event = cached;
    }
    return event ? { ...thread, event } : { ...thread, event: undefined };
  };
  const applyCachedNativeState = (thread: AttentionThread): AttentionThread => {
    const state = nativeLifecycle.get(String(thread.id));
    const event = cachedNativeEvents.get(String(thread.id));
    const eventStatus = event?.kind === "waiting" || event?.kind === "error" || event?.kind === "completed" ? event.kind : undefined;
    const status = eventStatus ?? (state?.phase === "waiting" || state?.phase === "running" || state?.phase === "error" || state?.phase === "completed"
      ? state.phase : thread.status);
    return { ...thread, status, ...(state?.turnId ? { turnId: state.turnId } : {}), ...(event ? { event } : {}) };
  };
  const onNotification = (notification: unknown): void => {
    activity.observeNotification(notification);
    const row = record(notification);
    const params = record(row?.params) ?? row;
    const method = text(row?.method);
    const threadId = text(params?.threadId) ?? text(params?.conversationId);
    let event = notificationEvent(notification);
    if (threadId && method === "turn/started") {
      const state = lifecycleFor(threadId);
      const turn = record(params?.turn);
      const nextTurnId = text(turn?.id) ?? text(params?.turnId);
      if (nextTurnId) state.turnId = nextTurnId;
      state.phase = "running";
      state.waitingSequence = 0;
      cachedNativeEvents.delete(threadId);
    } else if (threadId && (method === "thread/status/changed" || method === "harnessmix/thread/status/changed")) {
      const state = lifecycleFor(threadId);
      const status = nativeStatus(params?.status);
      if (status === "waiting") {
        if (state.phase !== "waiting") {
          state.waitingSequence += 1;
          const flags = record(params?.status)?.activeFlags;
          const suffix = Array.isArray(flags) ? flags.map(text).filter((v): v is string => !!v).sort().join(",") : "waiting";
          event = retainEvent({ id: `${threadId}:${state.turnId ?? "turn"}:waiting:${state.waitingSequence}:${suffix || "waiting"}`,
            threadId, kind: "waiting", at: timestamp(params?.timestamp, "native") ?? Date.now() });
        } else event = cachedNativeEvents.get(threadId);
        state.phase = "waiting";
      } else if (status === "running") {
        state.phase = "running";
        clearWaiting(threadId);
      } else if (status === "error") {
        state.phase = "error";
        event = retainEvent({ id: `${threadId}:${state.turnId ?? "thread"}:error:systemError`, threadId, kind: "error",
          at: timestamp(params?.timestamp, "native") ?? Date.now() });
      } else if (status === "idle" || status === "unknown") {
        state.phase = status;
        clearWaiting(threadId);
      }
    }
    if (event) {
      event = retainEvent(event);
      const state = lifecycleFor(event.threadId);
      if (event.kind === "completed" || event.kind === "error") state.phase = event.kind;
      const turn = record(params?.turn);
      const nextTurnId = text(turn?.id) ?? text(params?.turnId);
      if (nextTurnId) state.turnId = nextTurnId;
    }
    for (const listener of listeners) listener(event);
  };
  let disposed = false;
  return {
    async load(options = {}): Promise<AttentionData> {
      if (disposed) throw new Error("Attention client is disposed");
      let native: AttentionThread[] = [];
      let cursor: string | undefined;
      let partial = false;
      const warnings: string[] = [];
      try {
        for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
          const params = { limit: PAGE_SIZE, archived: false, ...(cursor ? { cursor } : {}) };
          const result = record(await sendRequest(NATIVE_THREAD_LIST_METHOD, params));
          const rows = Array.isArray(result?.data) ? result.data : [];
          native.push(...rows.map(row => {
            const thread = normalizeThread(row, "native");
            if (!thread) return null;
            return reconcileNative(thread);
          }).filter((v): v is AttentionThread => !!v));
          const next = text(result?.nextCursor) ?? text(result?.next_cursor);
          if (!next || rows.length === 0) break;
          cursor = next;
          if (page === MAX_THREAD_PAGES - 1) partial = true;
        }
        cachedNative = native;
      } catch (error) {
        native = cachedNative.map(applyCachedNativeState);
        warnings.push(error instanceof Error ? `Native thread history unavailable: ${error.message}` : "Native thread history unavailable");
      }
      const selectedProjectRoots = cachedProjects.find(project => project.id === options.projectId)?.rootPaths ?? [];
      if (options.includeGit === true) {
        const inspection = await activity.inspect(native, sendRequest, options.projectId, selectedProjectRoots);
        if (inspection.incomplete) {
          partial = true;
          warnings.push("部分任务的实际工作目录尚未检查。");
        }
        if (inspection.unavailable) warnings.push("部分任务的实际工作目录暂时无法读取。");
      }
      native = native.map(thread => activity.decorate(thread));
      const cwdPaths = activity.cwdPaths(native.concat(cachedManaged), options.projectId, MAX_CWDS, selectedProjectRoots);
      let projects: AttentionProject[] = cachedProjects;
      let managed: AttentionThread[] = cachedManaged;
      let repositories: AttentionRepository[] = options.includeGit === true ? cachedRepositories : cachedRepositories;
      try {
        const snapshot = record(await sendRequest(ATTENTION_SNAPSHOT_METHOD, { cwdPaths, includeGit: options.includeGit === true }));
        if (snapshot?.version !== 1) throw new Error("invalid attention snapshot version");
        projects = Array.isArray(snapshot.projects) ? snapshot.projects.map(normalizeProject).filter((v): v is AttentionProject => !!v) : [];
        managed = Array.isArray(snapshot.threads) ? snapshot.threads.map(row => normalizeThread(row, "harnessmix")).filter((v): v is AttentionThread => !!v).map(thread => activity.decorate(thread)) : [];
        if (options.includeGit === true) {
          repositories = Array.isArray(snapshot.repositories) ? snapshot.repositories.map(normalizeRepository).filter((v): v is AttentionRepository => !!v) : [];
        }
        cachedManaged = managed;
        cachedProjects = projects;
        if (options.includeGit === true) cachedRepositories = repositories;
        cachedGeneratedAt = number(snapshot.generatedAt) ?? Date.now();
        partial = partial || snapshot.partial === true || snapshot.truncated === true;
        if (Array.isArray(snapshot.errors)) {
          const repositoryDiagnostics = new Set(repositories.flatMap(repository => repository.error
            ? [`${repository.root}: ${repository.error}`, repository.error] : []));
          warnings.push(...snapshot.errors.map(text).filter((v): v is string => !!v && !repositoryDiagnostics.has(v) && !/not a git repository/i.test(v)));
        }
      } catch (error) {
        warnings.push(error instanceof Error ? `Managed attention snapshot unavailable: ${error.message}` : "Managed attention snapshot unavailable");
      }
      return { version: 1, generatedAt: cachedGeneratedAt || Date.now(), projects, threads: mergeThreads(native, managed).map(thread => activity.decorate(thread)), repositories, partial, errors: [...warnings], warnings };
    },
    subscribe(listener) {
      if (disposed) throw new Error("Attention client is disposed");
      listeners.add(listener);
      if (!detach && subscribe) detach = subscribe(TERMINAL_METHODS, onNotification);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { detach?.(); detach = undefined; }
      };
    },
    dispose() { if (disposed) return; disposed = true; detach?.(); detach = undefined; listeners.clear(); },
  };
}
