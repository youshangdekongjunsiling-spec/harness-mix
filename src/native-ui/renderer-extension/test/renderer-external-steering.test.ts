import { describe, expect, it, vi } from "vitest";

import { installRendererExternalSteering } from "../src/renderer-external-steering.js";

function fixture(owner: "external" | "codex" = "external") {
  const events: string[] = [];
  const requestOptions: Record<string, unknown> = { timeoutMs: 30_000 };
  let queued: Array<{ id: string; pausedReason?: string }> = [];
  const originalTurn = {
    turnId: "old",
    status: "inProgress",
    input: "original",
    steeringItems: [],
  };
  const turns = [originalTurn];
  const loadMessages = vi.fn(async () => undefined);
  const hasPendingTurnStart = vi.fn(() => false);
  const rpc = vi.fn(
    async (method: unknown, params: unknown, options?: unknown): Promise<unknown> => {
      void options;
      if (method === "harnessmix/thread/ownership/list") {
        return {
          threads: [
            { threadId: "thread", owner, ...(owner === "external" ? { harnessId: "pi" } : {}) },
          ],
        };
      }
      if (method === "turn/steer") {
        events.push("cancel old");
        originalTurn.status = "interrupted";
        queued = queued.map((message) => ({
          ...message,
          pausedReason: message.pausedReason ?? "Interrupted before the steer was accepted.",
        }));
        events.push("old completed");
        return { turnId: "replacement" };
      }
      return { method, params };
    },
  );
  const manager = {
    sendRequest: rpc,
    steerTurn: vi
      .fn<(...args: unknown[]) => Promise<{ turnId: string }>>()
      .mockResolvedValue({ turnId: "official" }),
    getStreamRole: vi.fn(() => ({ role: "owner" })),
    getTurnCoordinator: () => ({
      loadMessages,
      readMessages: () => queued,
      mutate: (_threadId: string, update: (messages: typeof queued) => typeof queued) => {
        queued = update(queued);
      },
      options: {
        submissionHost: {
          getActiveTurnId: () =>
            turns.at(-1)?.status === "inProgress" ? turns.at(-1)?.turnId : null,
          hasPendingTurnStart,
        },
      },
    }),
    startTurn: vi.fn(async (...args: unknown[]) => {
      const operation = args[1] as {
        request: { input: Array<{ text: string }>; clientUserMessageId: string };
        context: unknown;
      };
      const placeholder = {
        turnId: "",
        status: "inProgress",
        input: operation.request.input[0]?.text ?? "",
        steeringItems: [],
      };
      turns.push(placeholder);
      events.push("new input displayed");
      if (typeof args[2] === "function") await args[2]();
      const response = (await manager.sendRequest(
        "turn/start",
        operation.request,
        requestOptions,
      )) as { turn: { id: string } };
      placeholder.turnId = response.turn.id;
      events.push("new identity accepted");
      return response;
    }),
  };
  const originalSteer = manager.steerTurn;
  const dispose = installRendererExternalSteering(manager);
  if (!dispose) throw new Error("Synthetic Renderer steering binding was not installed");
  const args: unknown[] = [
    "thread",
    [{ type: "text", text: "new input", text_elements: [] }],
    { id: "message", cwd: "/project", context: { commentAttachments: [] } },
    null,
    [],
    "message",
    null,
    null,
    vi.fn(),
  ];
  return {
    manager,
    rpc,
    args,
    events,
    turns,
    originalSteer,
    dispose,
    requestOptions,
    loadMessages,
    hasPendingTurnStart,
    queue: {
      read: () => queued,
      set: (messages: typeof queued) => {
        queued = messages;
      },
    },
  };
}

describe("external direction changes use normal Desktop start presentation", () => {
  it("creates a new input placeholder, replaces through steer RPC, and never creates an old steering Item", async () => {
    const f = fixture();
    // Normal start operations carry their thread identity, as Desktop's start preparation does.
    await expect(f.manager.steerTurn(...f.args)).resolves.toEqual({ turnId: "replacement" });
    expect(f.originalSteer).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      "new input displayed",
      "cancel old",
      "old completed",
      "new identity accepted",
    ]);
    expect(f.turns).toEqual([
      { turnId: "old", status: "interrupted", input: "original", steeringItems: [] },
      { turnId: "replacement", status: "inProgress", input: "new input", steeringItems: [] },
    ]);
    expect(f.rpc).toHaveBeenLastCalledWith(
      "turn/steer",
      expect.objectContaining({
        threadId: "thread",
        expectedTurnId: "old",
        clientUserMessageId: "message",
        input: f.args[1],
      }),
      { timeoutMs: 30_000 },
    );
    expect(f.args[8]).toHaveBeenCalledOnce();
    f.dispose();
  });

  it("starts one idle follow-up without waiting for a stuck queue snapshot", async () => {
    const f = fixture();
    f.turns[0]!.status = "completed";
    // Desktop 26.1002 marks the submission currently entering steerTurn as
    // pending. Treating that as an older unconfirmed start rejects this very
    // submission before Host can receive it.
    f.hasPendingTurnStart.mockReturnValue(true);
    f.loadMessages.mockImplementation(() => new Promise(() => undefined));
    f.rpc.mockImplementation(async (method) => {
      if (method === "harnessmix/thread/ownership/list") {
        return { threads: [{ threadId: "thread", owner: "external", harnessId: "pi" }] };
      }
      if (method === "turn/start") return { turn: { id: "started" } };
      throw new Error(`unexpected ${String(method)}`);
    });

    await expect(f.manager.steerTurn(...f.args)).resolves.toEqual({ turnId: "started" });
    expect(f.hasPendingTurnStart).not.toHaveBeenCalled();
    expect(f.loadMessages).not.toHaveBeenCalled();
    expect(f.manager.startTurn).toHaveBeenCalledOnce();
    expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
      "harnessmix/thread/ownership/list",
      "turn/start",
    ]);
    f.dispose();
  });

  it("bounds an active queue snapshot and clears the pending replacement for retry", async () => {
    const f = fixture();
    f.loadMessages.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers();
    try {
      const first = f.manager.steerTurn(...f.args);
      const failed = expect(first).rejects.toThrow("queue snapshot timed out");
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      expect(f.manager.startTurn).not.toHaveBeenCalled();

      f.loadMessages.mockResolvedValue(undefined);
      await expect(f.manager.steerTurn(...f.args)).resolves.toEqual({ turnId: "replacement" });
      expect(f.manager.startTurn).toHaveBeenCalledOnce();
      expect(f.events.filter((event) => event === "cancel old")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
    f.dispose();
  });

  it("passes official steering and unrelated requests through unchanged", async () => {
    const f = fixture("codex");
    await expect(f.manager.steerTurn(...f.args)).resolves.toEqual({ turnId: "official" });
    expect(f.originalSteer).toHaveBeenCalledWith(...f.args);
    expect(f.manager.startTurn).not.toHaveBeenCalled();
    await f.manager.sendRequest(
      "turn/start",
      { threadId: "other", clientUserMessageId: "message" },
      { custom: true },
    );
    expect(f.rpc).toHaveBeenLastCalledWith(
      "turn/start",
      { threadId: "other", clientUserMessageId: "message" },
      { custom: true },
    );
    f.dispose();
    expect(f.manager.steerTurn).toBe(f.originalSteer);
    expect(f.manager.sendRequest).toBe(f.rpc);
  });

  it.each([
    { input: [] },
    { input: [{ type: "text", text: " " }] },
    { input: [{ type: "image", url: "image" }] },
    {
      input: [
        { type: "text", text: "new input" },
        { type: "localImage", path: "" },
      ],
    },
  ])("rejects unsupported input before cancel or creating a placeholder: %j", async ({ input }) => {
    const f = fixture();
    f.args[1] = input;
    await expect(f.manager.steerTurn(...f.args)).rejects.toThrow("text input");
    expect(f.manager.startTurn).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    f.dispose();
  });

  it("coalesces duplicate messages and rejects competing replacements", async () => {
    const f = fixture();
    const waiting = Promise.withResolvers<undefined>();
    f.args[8] = () => waiting.promise;
    const first = f.manager.steerTurn(...f.args);
    await vi.waitFor(() => expect(f.manager.startTurn).toHaveBeenCalledOnce());
    const duplicate = f.manager.steerTurn(...f.args);
    const competing = [...f.args];
    competing[5] = "different-message";
    await expect(f.manager.steerTurn(...competing)).rejects.toThrow("already changing direction");
    waiting.resolve(undefined);
    await expect(first).resolves.toEqual({ turnId: "replacement" });
    await expect(duplicate).resolves.toEqual({ turnId: "replacement" });
    expect(f.manager.startTurn).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event === "cancel old")).toHaveLength(1);
    f.dispose();
  });

  it("coalesces duplicate submissions that race through delayed ownership", async () => {
    const f = fixture();
    const ownership = Promise.withResolvers<unknown>();
    const original = f.rpc.getMockImplementation();
    f.rpc.mockImplementation(async (method, params, options) => {
      if (method === "harnessmix/thread/ownership/list") return ownership.promise;
      return original?.(method, params, options);
    });

    const first = f.manager.steerTurn(...f.args);
    const duplicate = f.manager.steerTurn(...f.args);
    await vi.waitFor(() => {
      expect(
        f.rpc.mock.calls.filter(([method]) => method === "harnessmix/thread/ownership/list"),
      ).toHaveLength(2);
    });
    ownership.resolve({
      threads: [{ threadId: "thread", owner: "external", harnessId: "pi" }],
    });

    await expect(first).resolves.toEqual({ turnId: "replacement" });
    await expect(duplicate).resolves.toEqual({ turnId: "replacement" });
    expect(f.manager.startTurn).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event === "cancel old")).toHaveLength(1);
    f.dispose();
  });

  it("retains Desktop outcome-unknown delivery tracking until the replacement is confirmed", async () => {
    const f = fixture();
    const response = Promise.withResolvers<unknown>();
    const unknown = vi.fn();
    f.requestOptions.onOutcomeUnknown = unknown;
    const original = f.rpc.getMockImplementation();
    f.rpc.mockImplementation(async (method, params, options) => {
      if (method !== "turn/steer") return original?.(method, params, options);
      expect(options).toBe(f.requestOptions);
      (options as { onOutcomeUnknown(delivery: unknown): void }).onOutcomeUnknown({
        requestId: "rpc",
        method,
        stage: "outcome-unknown",
      });
      return response.promise;
    });
    const result = f.manager.steerTurn(...f.args);
    await vi.waitFor(() => expect(unknown).toHaveBeenCalledOnce());
    expect(f.events).toEqual(["new input displayed"]);
    const duplicate = f.manager.steerTurn(...f.args);
    response.resolve({ turnId: "replacement" });
    await expect(result).resolves.toEqual({ turnId: "replacement" });
    await expect(duplicate).resolves.toEqual({ turnId: "replacement" });
    expect(f.manager.startTurn).toHaveBeenCalledOnce();
    f.dispose();
  });

  it("does not fall back to an ordinary start if disposed before dispatch", async () => {
    const f = fixture();
    const waiting = Promise.withResolvers<undefined>();
    f.args[8] = () => waiting.promise;
    const result = f.manager.steerTurn(...f.args);
    await vi.waitFor(() => expect(f.manager.startTurn).toHaveBeenCalledOnce());
    f.dispose();
    waiting.resolve(undefined);
    await expect(result).rejects.toThrow("disposed");
    expect(f.rpc.mock.calls.map(([method]) => method)).toEqual(["harnessmix/thread/ownership/list"]);
  });

  it("resumes automatically paused queue messages without unpausing older paused entries", async () => {
    const f = fixture();
    const pausedReason = "Interrupted before the steer was accepted.";
    f.queue.set([{ id: "queued" }, { id: "previously-paused", pausedReason }]);
    f.args[8] = () => f.queue.set([...f.queue.read(), { id: "queued-during-replacement" }]);
    await f.manager.steerTurn(...f.args);
    expect(f.queue.read()).toEqual([
      { id: "queued" },
      { id: "previously-paused", pausedReason },
      { id: "queued-during-replacement" },
    ]);
    f.dispose();
  });

  it("lets a follower delegate the original steer to its owning window", async () => {
    const f = fixture();
    f.manager.getStreamRole.mockReturnValue({ role: "follower" });
    await expect(f.manager.steerTurn(...f.args)).resolves.toEqual({ turnId: "official" });
    expect(f.originalSteer).toHaveBeenCalledWith(...f.args);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.manager.startTurn).not.toHaveBeenCalled();
    f.dispose();
  });

  it("degrades to stock steering when ownership cannot be resolved, and does not retry a failed replacement", async () => {
    const f = fixture();
    f.rpc.mockRejectedValueOnce(new Error("ownership unavailable"));
    await expect(f.manager.steerTurn(...f.args)).resolves.toEqual({ turnId: "official" });
    expect(f.originalSteer).toHaveBeenCalledWith(...f.args);
    expect(f.manager.startTurn).not.toHaveBeenCalled();
    f.rpc.mockImplementation(async (method) => {
      if (method === "harnessmix/thread/ownership/list")
        return { threads: [{ threadId: "thread", owner: "external", harnessId: "pi" }] };
      throw new Error("cancel failed");
    });
    await expect(f.manager.steerTurn(...f.args)).rejects.toThrow("cancel failed");
    expect(f.manager.startTurn).toHaveBeenCalledOnce();
    f.dispose();
  });

  it("degrades to stock steering when ownership resolution hangs past its bound", async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (method: unknown) => {
      if (method !== "harnessmix/thread/ownership/list") throw new Error("unexpected rpc");
      return new Promise(() => {});
    });
    vi.useFakeTimers();
    try {
      const result = f.manager.steerTurn(...f.args);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).resolves.toEqual({ turnId: "official" });
      expect(f.originalSteer).toHaveBeenCalledWith(...f.args);
      expect(f.manager.startTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    f.dispose();
  });

  it("resumes the paused follow-up queue when the replacement turn is rejected", async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (method: unknown) => {
      if (method === "harnessmix/thread/ownership/list")
        return { threads: [{ threadId: "thread", owner: "external", harnessId: "pi" }] };
      if (method === "turn/steer") {
        f.queue.set(
          f.queue.read().map((message) => ({
            ...message,
            pausedReason: "Interrupted before the steer was accepted.",
          })),
        );
        throw new Error("steer rejected");
      }
      throw new Error(`unexpected ${String(method)}`);
    });
    f.queue.set([{ id: "queued" }]);
    await expect(f.manager.steerTurn(...f.args)).rejects.toThrow("steer rejected");
    expect(f.queue.read()).toEqual([{ id: "queued" }]);
    f.dispose();
  });
});
