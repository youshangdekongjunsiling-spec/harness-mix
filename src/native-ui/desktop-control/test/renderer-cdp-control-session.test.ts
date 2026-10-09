import { describe, expect, it, vi } from "vitest";

import {
  createRendererCdpControlSession,
  selectPrimaryRendererTarget,
} from "../src/renderer-cdp-control-session.js";
import type { CdpTarget } from "../src/cdp-client.js";

function target(id: string, url = "app://-/index.html"): CdpTarget {
  return {
    id,
    type: "page",
    title: "Codex",
    url,
    webSocketDebuggerUrl: `ws://127.0.0.1:43123/devtools/page/${id}`,
  };
}

function readyBinding() {
  return {
    version: 2,
    enabledAgents: ["codex", "pi"],
    adapter: { state: "ready", reason: "ready" },
  };
}

function rendererClient(binding = readyBinding()) {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const bindingListeners = new Set<(params: unknown) => void>();
  let bindingLive = true;
  const evaluateSpy = vi.fn(async (expression: string) => {
    void expression;
    return binding as unknown;
  });
  const client = {
    commands,
    evaluateSpy,
    command: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, ...(params ? { params } : {}) });
      if (method === "Runtime.removeBinding") bindingLive = false;
      if (method === "Runtime.addBinding") bindingLive = true;
      if (
        method === "Runtime.evaluate" &&
        bindingLive &&
        typeof params?.expression === "string" &&
        params.expression.includes("__harnessmixControllerBindingProbeV1")
      ) {
        const id = params.expression.match(/"id":"([^"]+)"/)?.[1];
        if (id) {
          const payload = JSON.stringify({
            __harnessmixControllerBindingProbeV1: { version: 1, id },
          });
          for (const listener of bindingListeners) {
            listener({ name: "__harnessmixSidecarSendV1", payload });
          }
        }
      }
      if (method === "Runtime.evaluate") return { result: { type: "undefined" } };
      return {};
    }),
    async evaluate<T>(expression: string): Promise<T> {
      return (await evaluateSpy(expression)) as T;
    },
    on: vi.fn((method: string, listener: (params: unknown) => void) => {
      if (method === "Runtime.bindingCalled") bindingListeners.add(listener);
      return () => bindingListeners.delete(listener);
    }),
    emitBinding(payload: string) {
      for (const listener of bindingListeners) {
        listener({ name: "__harnessmixSidecarSendV1", payload });
      }
    },
    setBindingLive(value: boolean) {
      bindingLive = value;
    },
    bindingListenerCount() {
      return bindingListeners.size;
    },
    close: vi.fn(),
  };
  return client;
}

describe("Renderer CDP Control Session", () => {
  it("selects only the exact primary app surface and preserves an owned target", () => {
    const first = target("page-1");
    const owned = target("page-2");
    expect(
      selectPrimaryRendererTarget([
        target("overlay", "app://-/avatar-overlay.html"),
        { ...target("worker"), type: "worker" },
        first,
        target("query", "app://-/index.html?window=second"),
        owned,
      ]),
    ).toBe(first);
    expect(selectPrimaryRendererTarget([first, owned], "page-2")).toBe(owned);
    expect(
      selectPrimaryRendererTarget([target("overlay", "app://-/avatar-overlay.html")]),
    ).toBeNull();
  });

  it("registers future-document injection before evaluating the current document", async () => {
    const client = rendererClient();
    const source = "globalThis.__harnessmixInstalled = true";
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: source,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    expect(client.commands).toEqual([
      { method: "Runtime.enable" },
      { method: "Page.enable" },
      { method: "Page.addScriptToEvaluateOnNewDocument", params: { source } },
      {
        method: "Runtime.evaluate",
        params: { expression: source, awaitPromise: true },
      },
    ]);
    expect(session.snapshot.binding).toEqual(readyBinding());
    session.close();
  });

  it("carries explicitly routed Host frames over a separate CDP binding", async () => {
    const client = rendererClient();
    let output: ((frame: string) => void) | undefined;
    const sidecar = {
      send: vi.fn(),
      onFrame: vi.fn((listener: (frame: string) => void) => {
        output = listener;
        return () => undefined;
      }),
      close: vi.fn(),
    };
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      sidecar,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    expect(client.commands[2]).toEqual({
      method: "Runtime.removeBinding", params: { name: "__harnessmixSidecarSendV1" },
    });
    expect(client.commands[3]).toEqual({
      method: "Runtime.addBinding", params: { name: "__harnessmixSidecarSendV1" },
    });
    client.emitBinding('{"id":1,"method":"harnessmix/thread/list"}');
    expect(sidecar.send).toHaveBeenCalledWith('{"id":1,"method":"harnessmix/thread/list"}');
    output?.('{"id":1,"result":{"data":[]}}');
    expect(client.command).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: expect.stringContaining('window.__harnessmixSidecarReceiveV1(frame)'),
    });
    expect(client.command).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: expect.stringContaining("(window.__harnessmixPendingSidecarFramesV1 ??= []).push(frame)"),
    });
    session.close();
  });

  it("parks Host frames when the bridge receive handler is not installed yet", async () => {
    const client = rendererClient();
    let output: ((frame: string) => void) | undefined;
    const sidecar = {
      send: vi.fn(),
      onFrame: vi.fn((listener: (frame: string) => void) => {
        output = listener;
        return () => undefined;
      }),
      close: vi.fn(),
    };
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      sidecar,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });
    output?.('{"method":"thread/started","params":{"thread":{"id":"parked"}}}');
    const relay = client.commands.find(
      (entry) => typeof entry.params?.expression === "string" && entry.params.expression.includes("__harnessmixPendingSidecarFramesV1"),
    ) as { method: string; params: { expression: string } } | undefined;
    expect(relay?.method).toBe("Runtime.evaluate");
    // 停机坪表达式在 receive 未装好时把帧推入页面级队列而不是丢弃
    expect(relay?.params.expression).toContain('if (typeof window.__harnessmixSidecarReceiveV1 === "function")');
    expect(relay?.params.expression).toContain("(window.__harnessmixPendingSidecarFramesV1 ??= []).push(frame)");
    session.close();
  });

  it("repairs a dead outbound binding even when renderer readiness remains healthy", async () => {
    const client = rendererClient();
    const sidecar = {
      send: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const connect = vi.fn(async () => client);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      sidecar,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    client.setBindingLive(false);
    await expect(session.ensureInstalled()).resolves.toMatchObject({ target: { id: "page-1" } });
    expect(connect).toHaveBeenCalledOnce();
    expect(client.commands.filter(({ method }) => method === "Runtime.addBinding")).toHaveLength(2);
    expect(client.on).toHaveBeenCalledOnce();
    expect(sidecar.send).not.toHaveBeenCalled();
    expect(
      client.commands.filter(({ params }) =>
        String(params?.expression).includes("recoverPendingApprovals"),
      ),
    ).toHaveLength(1);
    session.close();
  });

  it("fails within the probe deadline when binding events have no live listener", async () => {
    const client = rendererClient();
    client.on.mockImplementation(() => () => undefined);
    const sidecar = {
      send: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      close: vi.fn(),
    };

    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        sidecar,
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        operations: {
          listTargets: vi.fn(async () => [target("page-1")]),
          connect: vi.fn(async () => client),
          installDraftPrewarmPolicy: vi.fn(async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          })),
        },
      }),
    ).rejects.toThrow("Renderer CDP sidecar binding probe timed out");
    expect(client.close).toHaveBeenCalledOnce();
    expect(sidecar.send).not.toHaveBeenCalled();
  });

  it("keeps healthy liveness checks on one listener and consumes probes locally", async () => {
    const client = rendererClient();
    const sidecar = {
      send: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      sidecar,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await Promise.all([session.ensureInstalled(), session.ensureInstalled()]);
    expect(client.on).toHaveBeenCalledOnce();
    expect(client.bindingListenerCount()).toBe(1);
    expect(client.commands.filter(({ method }) => method === "Runtime.addBinding")).toHaveLength(1);
    expect(sidecar.send).not.toHaveBeenCalled();
    expect(
      client.commands.filter(({ params }) =>
        String(params?.expression).includes("recoverPendingApprovals"),
      ),
    ).toHaveLength(0);
    session.close();
    expect(client.bindingListenerCount()).toBe(0);
  });

  it("hands replacement relay ownership over without duplicate forwarding", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    const sidecar = {
      send: vi.fn(),
      onFrame: vi.fn(() => () => undefined),
      close: vi.fn(),
    };
    let inventory = [target("page-1")];
    let releaseReplacement: (() => void) | undefined;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let installs = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      sidecar,
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement),
        installDraftPrewarmPolicy: vi.fn(async () => {
          installs += 1;
          if (installs === 2) await replacementReady;
          return { state: "ready" as const, reason: "owned-request-bridge" as const };
        }),
      },
    });

    inventory = [target("page-2")];
    const replacing = session.ensureInstalled();
    await vi.waitFor(() => expect(replacement.bindingListenerCount()).toBe(1));
    const request = '{"id":7,"method":"harnessmix/thread/list"}';
    first.emitBinding(request);
    replacement.emitBinding(request);
    expect(sidecar.send).toHaveBeenCalledTimes(1);
    releaseReplacement?.();
    await replacing;
    first.emitBinding(request);
    replacement.emitBinding(request);
    expect(sidecar.send).toHaveBeenCalledTimes(2);
    expect(first.bindingListenerCount()).toBe(0);
    expect(
      replacement.commands.filter(({ params }) =>
        String(params?.expression).includes("recoverPendingApprovals"),
      ),
    ).toHaveLength(1);
    session.close();
  });

  it("activates the owned page target", async () => {
    const client = rendererClient();
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => [target("page-1")]),
        connect: vi.fn(async () => client),
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    await expect(session.activateDesktop()).resolves.toBe(1);
    expect(client.command).toHaveBeenLastCalledWith("Page.bringToFront");
    session.close();
  });

  it("fails closed when the injected Adapter is unsupported", async () => {
    const client = rendererClient({
      version: 2,
      enabledAgents: ["codex", "pi"],
      adapter: { state: "unsupported", reason: "signature-mismatch" },
    } as never);
    await expect(
      createRendererCdpControlSession({
        rendererCdpEndpoint: "http://127.0.0.1:43123",
        rendererSource: "production renderer",
        pollIntervalMs: 1,
        timeoutMs: 100,
        operations: {
          listTargets: vi.fn(async () => [target("page-1")]),
          connect: vi.fn(async () => client),
          installDraftPrewarmPolicy: vi.fn(async () => ({
            state: "ready" as const,
            reason: "owned-request-bridge" as const,
          })),
        },
      }),
    ).rejects.toThrow("Production Renderer Adapter is unsupported: signature-mismatch");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("reconnects and installs a replacement primary target", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect,
        installDraftPrewarmPolicy: vi.fn(async () => ({
          state: "ready" as const,
          reason: "owned-request-bridge" as const,
        })),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).resolves.toMatchObject({
      target: { id: "page-2" },
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    await session.executeRenderer("42");
    expect(replacement.evaluateSpy).toHaveBeenLastCalledWith("42");
    session.close();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("does not replace the installed snapshot when replacement installation fails", async () => {
    const first = rendererClient();
    const replacement = rendererClient();
    let inventory = [target("page-1")];
    let installs = 0;
    const session = await createRendererCdpControlSession({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: "production renderer",
      pollIntervalMs: 1,
      timeoutMs: 100,
      operations: {
        listTargets: vi.fn(async () => inventory),
        connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(replacement),
        installDraftPrewarmPolicy: vi.fn(async () => {
          installs += 1;
          if (installs > 1) throw new Error("request manager unavailable");
          return { state: "ready" as const, reason: "owned-request-bridge" as const };
        }),
      },
    });

    inventory = [target("page-2")];
    await expect(session.ensureInstalled()).rejects.toThrow("request manager unavailable");
    expect(session.snapshot.target.id).toBe("page-1");
    expect(first.close).not.toHaveBeenCalled();
    expect(replacement.close).toHaveBeenCalledOnce();
    session.close();
  });
});
