import { describe, expect, it } from "vitest";
import { createAttentionActivityTracker, localAbsolutePath } from "../src/attention-activity.js";
import type { AttentionThread } from "../src/attention-types.js";

const thread = (id: string, extra: Partial<AttentionThread> = {}): AttentionThread => ({
  id, title: id, harnessId: "codex", cwd: "C:/startup", projectId: null, updatedAt: 1,
  status: "idle", source: "native", ...extra,
});

describe("attention activity", () => {
  it("accepts local absolute paths and rejects malformed, URL, and UNC values", () => {
    expect(localAbsolutePath("C:\\repo\\worktree")).toBe("C:\\repo\\worktree");
    expect(localAbsolutePath("/Users/me/repo")).toBe("/Users/me/repo");
    expect(localAbsolutePath("relative/repo")).toBeUndefined();
    expect(localAbsolutePath("https://example.test/repo")).toBeUndefined();
    expect(localAbsolutePath("\\\\server\\share")).toBeUndefined();
    expect(localAbsolutePath(`C:/${"x".repeat(16_383)}`)).toBeUndefined();
  });

  it("keeps item events isolated by thread and ignores stale history completion", async () => {
    let clock = 100;
    const tracker = createAttentionActivityTracker({ storage: null, now: () => ++clock });
    let resolveRead!: (value: unknown) => void;
    const read = new Promise<unknown>(resolve => { resolveRead = resolve; });
    const pending = tracker.inspect([thread("a")], () => read);
    tracker.observeNotification({ method: "item/started", params: { threadId: "a", item: { type: "commandExecution", id: "live", cwd: "C:/live", command: "private" } } });
    tracker.observeNotification({ method: "item/completed", params: { threadId: "b", item: { type: "commandExecution", id: "other", cwd: "C:/other" } } });
    resolveRead({ thread: { turns: [{ items: [{ type: "commandExecution", id: "stale", cwd: "C:/stale" }] }] } });
    await pending;
    expect(tracker.decorate(thread("a")).activity).toMatchObject({ cwd: "C:/live", itemId: "live" });
    expect(tracker.decorate(thread("b")).activity).toMatchObject({ cwd: "C:/other", itemId: "other" });
  });

  it("persists only bounded path provenance and restores it", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const tracker = createAttentionActivityTracker({ storage, now: () => 1_000 });
    tracker.observeNotification({ method: "item/completed", params: { threadId: "t", item: {
      type: "commandExecution", id: "i", cwd: "C:/actual", command: "do not save", aggregatedOutput: "do not save output",
    } } });
    const persisted = [...values.values()].join("");
    expect(persisted).toContain("C:/actual");
    expect(persisted).not.toContain("do not save");
    expect(createAttentionActivityTracker({ storage, now: () => 1_001 }).decorate(thread("t")).activity?.cwd).toBe("C:/actual");
  });

  it("bounds history reads to eight with concurrency two and advances to unvisited threads", async () => {
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const tracker = createAttentionActivityTracker({ storage: null, now: () => 10_000 });
    const rows = Array.from({ length: 10 }, (_, index) => thread(`t${index}`, { updatedAt: 10 - index }));
    const send = async (_method: string, params: unknown) => {
      const id = (params as { threadId: string }).threadId;
      calls.push(id);
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { thread: { turns: [] } };
    };
    const first = await tracker.inspect(rows, send);
    const second = await tracker.inspect(rows, send);
    expect(first).toMatchObject({ attempted: 8, incomplete: true });
    expect(second).toMatchObject({ attempted: 2, incomplete: false });
    expect(new Set(calls).size).toBe(10);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("prioritizes the selected project by root when native rows have no project id", async () => {
    const calls: string[] = [];
    const tracker = createAttentionActivityTracker({ storage: null, now: () => 10_000 });
    const rows = Array.from({ length: 8 }, (_, index) => thread(`other-${index}`, { cwd: `C:/other/${index}`, updatedAt: 100 - index }))
      .concat(thread("selected", { cwd: "C:/selected/nested", updatedAt: 1 }));
    await tracker.inspect(rows, async (_method, params) => {
      calls.push((params as { threadId: string }).threadId);
      return { thread: { turns: [] } };
    }, "project", ["C:/selected"]);
    expect(calls[0]).toBe("selected");
  });

  it("moves activity when a later structured item changes cwd", () => {
    let clock = 0;
    const tracker = createAttentionActivityTracker({ storage: null, now: () => ++clock });
    tracker.observeNotification({ method: "item/started", params: { threadId: "t", item: { type: "commandExecution", id: "one", cwd: "C:/one" } } });
    tracker.observeNotification({ method: "item/completed", params: { threadId: "t", item: { type: "commandExecution", id: "two", cwd: "C:/two" } } });
    expect(tracker.decorate(thread("t")).activity).toMatchObject({ cwd: "C:/two", itemId: "two" });
  });

  it("updates changed managed worktree roots without replacing command evidence", () => {
    let clock = 10;
    const tracker = createAttentionActivityTracker({ storage: null, now: () => ++clock });
    const managed = (root: string): AttentionThread => thread("managed", {
      source: "harnessmix", harnessId: "pi", workspace: { mode: "worktree", root },
    });
    expect(tracker.decorate(managed("C:/worktree/one")).activity).toMatchObject({ cwd: "C:/worktree/one", source: "worktree" });
    expect(tracker.decorate(managed("C:/worktree/two")).activity).toMatchObject({ cwd: "C:/worktree/two", source: "worktree" });
    tracker.observeNotification({ method: "item/started", params: { threadId: "managed", item: { type: "commandExecution", cwd: "C:/command" } } });
    expect(tracker.decorate(managed("C:/worktree/three")).activity).toMatchObject({ cwd: "C:/command", source: "command" });
  });

  it("removes persisted worktree activity when explicit worktree ownership disappears", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const tracker = createAttentionActivityTracker({ storage, now: () => 100 });
    const owned = thread("managed", { source: "harnessmix", harnessId: "pi", workspace: { mode: "worktree", root: "C:/owned" } });
    expect(tracker.decorate(owned).activity).toMatchObject({ cwd: "C:/owned", source: "worktree" });
    expect(tracker.decorate({ ...owned, workspace: undefined }).activity).toBeUndefined();
    expect([...values.values()].join("")).not.toContain("C:/owned");
  });

  it("deduplicates Windows slash and case variants while preserving POSIX case", () => {
    const tracker = createAttentionActivityTracker({ storage: null });
    const paths = tracker.cwdPaths([
      thread("w1", { cwd: "C:/Repo" }), thread("w2", { cwd: "c:\\repo" }),
      thread("p1", { cwd: "/Repo" }), thread("p2", { cwd: "/repo" }),
    ]);
    expect(paths).toEqual(["C:/Repo", "/Repo", "/repo"]);
  });
});
