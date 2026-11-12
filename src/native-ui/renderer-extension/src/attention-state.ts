import type { AttentionData, AttentionEvent } from "./attention-types.js";

export const ATTENTION_STATE_VERSION = 1;
export const ATTENTION_STATE_MAX_BYTES = 64 * 1024;

export interface AttentionProjectView { branch?: string; conversationId?: string; }
export interface AttentionState {
  version: 1;
  selectedProjectId: string | null;
  currentProject: string | null;
  projectViews: Record<string, AttentionProjectView>;
  events: AttentionEvent[];
  readEventIds: string[];
  seeded: boolean;
  seededAt: number | null;
}

export const createAttentionState = (): AttentionState => ({ version: 1, selectedProjectId: null, currentProject: null, projectViews: {}, events: [], readEventIds: [], seeded: false, seededAt: null });
export const emptyAttentionState = createAttentionState;
const validEventId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length < 512;
const validThreadId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length < 512;
const validKind = (value: unknown): value is AttentionEvent["kind"] => value === "completed" || value === "waiting" || value === "error";
const utf8Bytes = (value: string): number => typeof TextEncoder === "function" ? new TextEncoder().encode(value).byteLength : value.length;

export function parseAttentionState(raw: string | null | undefined): AttentionState {
  if (!raw) return emptyAttentionState();
  if (utf8Bytes(raw) > ATTENTION_STATE_MAX_BYTES) return emptyAttentionState();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1) return emptyAttentionState();
    const views: Record<string, AttentionProjectView> = {};
    if (value.projectViews && typeof value.projectViews === "object") for (const [id, candidate] of Object.entries(value.projectViews)) {
      if (!candidate || typeof candidate !== "object" || !validEventId(id) || id === "__proto__") continue;
      const item = candidate as Record<string, unknown>;
      views[id] = { ...(typeof item.branch === "string" && item.branch.length < 512 ? { branch: item.branch } : {}), ...(typeof item.conversationId === "string" && validThreadId(item.conversationId) ? { conversationId: item.conversationId } : {}) };
    }
    const currentProject = typeof value.currentProject === "string" ? value.currentProject : typeof value.selectedProjectId === "string" ? value.selectedProjectId : null;
    const events = Array.isArray(value.events) ? value.events.map(candidate => {
      if (!candidate || typeof candidate !== "object") return null;
      const event = candidate as Record<string, unknown>;
      return validEventId(event.id) && validThreadId(event.threadId) && validKind(event.kind) && typeof event.at === "number" && Number.isFinite(event.at)
        ? { id: event.id, threadId: event.threadId, kind: event.kind, at: event.at } : null;
    }).filter((event): event is AttentionEvent => !!event).slice(-512) : [];
    const readEventIds = Array.isArray(value.readEventIds) ? [...new Set(value.readEventIds.filter(validEventId))].slice(-512) : [];
    return { version: 1, selectedProjectId: currentProject, currentProject, projectViews: views, events, readEventIds, seeded: value.seeded === true, seededAt: typeof value.seededAt === "number" && Number.isFinite(value.seededAt) ? value.seededAt : null };
  } catch { return emptyAttentionState(); }
}

export function serializeAttentionState(state: AttentionState): string {
  const currentProject = state.currentProject ?? state.selectedProjectId ?? null;
  const events = state.events.filter(event => validEventId(event.id) && validThreadId(event.threadId) && validKind(event.kind)).slice(-512);
  const normalized: AttentionState = { version: 1, selectedProjectId: currentProject, currentProject, projectViews: state.projectViews ?? {}, events, readEventIds: [...new Set(state.readEventIds.filter(validEventId))].slice(-512), seeded: state.seeded === true, seededAt: state.seededAt ?? null };
  let raw = JSON.stringify(normalized);
  if (utf8Bytes(raw) <= ATTENTION_STATE_MAX_BYTES) return raw;
  normalized.readEventIds = normalized.readEventIds.slice(-64);
  normalized.events = normalized.events.slice(-128);
  raw = JSON.stringify(normalized);
  return utf8Bytes(raw) <= ATTENTION_STATE_MAX_BYTES ? raw : JSON.stringify({ version: 1, selectedProjectId: normalized.selectedProjectId, currentProject: normalized.currentProject, projectViews: {}, events: [], readEventIds: [], seeded: normalized.seeded, seededAt: normalized.seededAt });
}

export function applyAttentionSnapshot(state: AttentionState, data: AttentionData): AttentionState {
  const next = { ...state, projectViews: { ...state.projectViews }, readEventIds: [...state.readEventIds] };
  const events = data.threads.map(thread => thread.event).filter((event): event is AttentionEvent => !!event);
  next.events = [...next.events, ...events].reduce<AttentionEvent[]>((all, event) => {
    const index = all.findIndex(candidate => candidate.id === event.id);
    if (index >= 0) all[index] = event; else all.push(event);
    return all;
  }, []).slice(-512);
  const hasUsableSnapshot = data.threads.length > 0 || data.projects.length > 0 || data.repositories.length > 0;
  if (!next.seeded && hasUsableSnapshot && data.errors.length === 0) {
    next.readEventIds = [...new Set([...next.readEventIds, ...events.filter(event => event.kind === "completed").map(event => event.id)])];
    next.seeded = true;
    next.seededAt = data.generatedAt;
  } else {
    const baseline = next.seededAt;
    const historicalCompleted = baseline === null ? [] : events.filter(event => event.kind === "completed" && event.at <= baseline).map(event => event.id);
    next.readEventIds = [...new Set([...next.readEventIds, ...historicalCompleted])].filter(id => next.events.some(event => event.id === id));
  }
  return next;
}

export function markAttentionThreadRead(state: AttentionState, data: AttentionData, threadId: string): AttentionState {
  const ids = state.events.concat(data.threads.map(thread => thread.event).filter((event): event is AttentionEvent => !!event)).filter(event => event.threadId === threadId).map(event => event.id);
  return { ...state, readEventIds: [...new Set([...state.readEventIds, ...ids])] };
}

export function attentionUnreadEventIds(state: AttentionState, data: AttentionData): string[] {
  return attentionUnreadEvents(state, data).map(event => event.id);
}

export function attentionUnreadEvents(state: AttentionState, data?: AttentionData): AttentionEvent[] {
  const read = new Set(state.readEventIds);
  const current = data?.threads.map(thread => thread.event).filter((event): event is AttentionEvent => !!event) ?? [];
  const all = [...state.events, ...current].reduce<AttentionEvent[]>((result, event) => {
    const index = result.findIndex(candidate => candidate.id === event.id);
    if (index >= 0) result[index] = event; else result.push(event);
    return result;
  }, []);
  return all.filter(event => !read.has(event.id));
}

export const ingestAttentionData = applyAttentionSnapshot;
export const markThreadRead = markAttentionThreadRead;
export const unreadEvents = attentionUnreadEventIds;
