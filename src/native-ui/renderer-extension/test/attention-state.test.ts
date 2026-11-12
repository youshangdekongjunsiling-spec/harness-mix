import { describe, expect, it } from "vitest";
import { applyAttentionSnapshot, attentionUnreadEventIds, createAttentionState, markAttentionThreadRead, parseAttentionState, serializeAttentionState } from "../src/attention-state.js";
import type { AttentionData } from "../src/attention-types.js";

const data = (generatedAt: number, eventId: string, threadId: string, projectId: string): AttentionData => ({
  version: 1, generatedAt, partial: false, errors: [], warnings: [],
  projects: [{ id: projectId, name: projectId, rootPaths: [] }], repositories: [],
  threads: [{ id: threadId, title: threadId, harnessId: "pi", cwd: null, projectId, updatedAt: generatedAt, status: "waiting", event: { id: eventId, threadId, kind: "waiting", at: generatedAt } }],
});

describe("attention state", () => {
  it("seeds historical completions once and keeps waiting unread", () => {
    const first = data(1, "old", "t1", "p1");
    first.threads[0]!.event = { id: "old", threadId: "t1", kind: "completed", at: 1 };
    let state = applyAttentionSnapshot(createAttentionState(), first);
    expect(attentionUnreadEventIds(state, first)).toEqual([]);
    const next = data(2, "new", "t2", "p2");
    state = applyAttentionSnapshot(state, next);
    expect(attentionUnreadEventIds(state, next)).toEqual(["new"]);
  });

  it("dedupes, isolates project thread reads, and restores presentation", () => {
    let state = createAttentionState();
    const p1 = data(1, "e1", "t1", "p1");
    const p2 = data(1, "e2", "t2", "p2");
    state = applyAttentionSnapshot(state, { ...p1, threads: [...p1.threads, ...p2.threads] });
    state = markAttentionThreadRead(state, { ...p1, threads: [...p1.threads, ...p2.threads] }, "t1");
    state.currentProject = "p2";
    state.selectedProjectId = "p2";
    state.projectViews.p2 = { branch: "feature", conversationId: "t2" };
    state = applyAttentionSnapshot(state, { ...p1, threads: [...p1.threads, ...p2.threads] });
    expect(state.readEventIds).toEqual(["e1"]);
    expect(attentionUnreadEventIds(state, { ...p1, threads: [...p1.threads, ...p2.threads] })).toEqual(["e2"]);
    const restored = parseAttentionState(serializeAttentionState(state));
    expect(restored.currentProject).toBe("p2");
    expect(restored.projectViews.p2).toEqual({ branch: "feature", conversationId: "t2" });
    expect(restored.readEventIds).toEqual(["e1"]);
  });

  it("does not reflood historical managed completions after a host recovery", () => {
    let state = createAttentionState();
    const initial = data(100, "old-complete", "t1", "p1");
    initial.threads[0]!.event = { id: "old-complete", threadId: "t1", kind: "completed", at: 90 };
    state = applyAttentionSnapshot(state, initial);
    expect(attentionUnreadEventIds(state, initial)).toEqual([]);
    const recovery = { ...initial, generatedAt: 200, errors: [], warnings: [], threads: [{ ...initial.threads[0]!, event: { id: "old-complete", threadId: "t1", kind: "completed" as const, at: 90 } }] };
    expect(attentionUnreadEventIds(state, recovery)).toEqual([]);
    const later = { ...recovery, generatedAt: 300, threads: [{ ...recovery.threads[0]!, event: { id: "new-complete", threadId: "t1", kind: "completed" as const, at: 250 } }] };
    state = applyAttentionSnapshot(state, later);
    expect(attentionUnreadEventIds(state, later)).toEqual(["new-complete"]);
  });
});
