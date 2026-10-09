/**
 * Renderer control over the direct page-level CDP endpoint: waits for the
 * primary `app://-/index.html` target, installs the renderer bundle
 * (`Page.addScriptToEvaluateOnNewDocument` + immediate evaluation), wires the
 * sidecar frame bridge and re-installs wholesale whenever the target is
 * replaced (window reload / recreation).
 */
import {
  CdpClient,
  listCdpTargets,
  type CdpClientOptions,
  type CdpFetch,
  type CdpTarget,
} from "./cdp-client.js";
import {
  installRendererDraftPrewarmPolicyDirect,
  type RendererDraftPrewarmPolicyStatus,
} from "./renderer-draft-prewarm-policy.js";
import type { LocalSidecar } from "./local-sidecar.js";

const SIDECAR_BINDING_NAME = "__harnessmixSidecarSendV1";
const SIDECAR_PROBE_KEY = "__harnessmixControllerBindingProbeV1";
const MAX_SIDECAR_PROBE_TIMEOUT_MS = 2_000;
let sidecarProbeSequence = 0;

function recoverPendingApprovals(renderer: RendererConnection): void {
  void renderer
    .command("Runtime.evaluate", {
      expression:
        "window.__harnessmixSidecarRequestV1?.recoverPendingApprovals?.() ?? 0",
      returnByValue: true,
    })
    .catch(() => undefined);
}

export interface ProductionRendererStatus {
  version: 2;
  enabledAgents: string[];
  adapter: {
    state: "ready";
    reason: string;
  };
}

export interface RendererCdpControlSnapshot {
  target: CdpTarget;
  draftPrewarmPolicy: RendererDraftPrewarmPolicyStatus;
  binding: ProductionRendererStatus;
}

interface RendererConnection {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  on?(method: string, listener: (params: unknown) => void): () => void;
  close(): void;
}

interface CdpOperations {
  listTargets(endpoint: string): Promise<CdpTarget[]>;
  connect(webSocketDebuggerUrl: string): Promise<RendererConnection>;
  installDraftPrewarmPolicy(renderer: RendererConnection): Promise<RendererDraftPrewarmPolicyStatus>;
}

export interface RendererCdpControlSession {
  readonly snapshot: RendererCdpControlSnapshot;
  ensureInstalled(): Promise<RendererCdpControlSnapshot>;
  activateDesktop(): Promise<number>;
  executeRenderer<T>(expression: string): Promise<T>;
  close(): void;
}

export interface InstallRendererCdpControlOptions {
  rendererCdpEndpoint: string;
  rendererSource: string;
  sidecar?: LocalSidecar;
  enabledAgents?: readonly string[];
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface CreateSessionOptions extends InstallRendererCdpControlOptions {
  operations?: CdpOperations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The renderer bundle and the controller keep independently ordered catalogs. */
function sameAgentSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((agent) => actual.includes(agent));
}

function isPrimaryRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "app:" &&
      url.hostname === "-" &&
      url.pathname === "/index.html" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function selectPrimaryRendererTarget(
  targets: readonly CdpTarget[],
  preferredTargetId?: string,
): CdpTarget | null {
  const pages = targets.filter(
    (target) => target.type === "page" && isPrimaryRendererUrl(target.url),
  );
  return pages.find((target) => target.id === preferredTargetId) ?? pages.at(0) ?? null;
}

class RendererAdapterReadinessError extends Error {
  constructor(
    readonly state: string,
    readonly reason: string,
  ) {
    super(`Production Renderer Adapter is ${state}: ${reason}`);
    this.name = "RendererAdapterReadinessError";
  }
}

function validateBindingStatus(
  value: unknown,
  expectedAgents: readonly string[],
): ProductionRendererStatus {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.enabledAgents) ||
    value.enabledAgents.some((agent) => typeof agent !== "string") ||
    !sameAgentSet(value.enabledAgents as string[], expectedAgents) ||
    !isRecord(value.adapter)
  ) {
    throw new Error("Production Renderer binding returned an invalid status");
  }
  if (value.adapter.state !== "ready" || typeof value.adapter.reason !== "string") {
    throw new RendererAdapterReadinessError(
      typeof value.adapter.state === "string" ? value.adapter.state : "invalid",
      typeof value.adapter.reason === "string" ? value.adapter.reason : "unknown",
    );
  }
  return value as unknown as ProductionRendererStatus;
}

async function waitForPrimaryTarget(
  endpoint: string,
  operations: CdpOperations,
  timeoutMs: number,
  pollIntervalMs: number,
  preferredTargetId?: string,
): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const target = selectPrimaryRendererTarget(
        await operations.listTargets(endpoint),
        preferredTargetId,
      );
      if (target) return target;
      lastFailure = new Error("Renderer CDP has no primary app://-/index.html page target");
    } catch (error) {
      lastFailure = error;
    }
    await wait(pollIntervalMs);
  }
  const detail = lastFailure instanceof Error ? `: ${lastFailure.message}` : "";
  throw new Error(`Primary Codex Renderer CDP target did not become ready${detail}`);
}

async function evaluateSource(renderer: RendererConnection, source: string): Promise<void> {
  const response = await renderer.command("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
  });
  if (!isRecord(response)) {
    throw new Error("Renderer source evaluation returned an invalid result");
  }
  if (isRecord(response.exceptionDetails)) {
    throw new Error(
      typeof response.exceptionDetails.text === "string"
        ? response.exceptionDetails.text
        : "Renderer source evaluation failed",
    );
  }
}

const readBinding = (renderer: RendererConnection): Promise<unknown> =>
  renderer.evaluate<unknown>("window.__harnessmixRendererBindingProbeV1?.status() ?? null");

async function waitForBinding(
  renderer: RendererConnection,
  enabledAgents: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ProductionRendererStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await readBinding(renderer);
      if (value !== null) return validateBindingStatus(value, enabledAgents);
    } catch (error) {
      lastFailure = error;
      // "installing" is the only transient adapter state; anything else is fatal.
      if (error instanceof RendererAdapterReadinessError && error.state !== "installing") {
        throw error;
      }
    }
    await wait(pollIntervalMs);
  }
  const detail = lastFailure instanceof Error ? `: ${lastFailure.message}` : "";
  throw new Error(`Production Renderer binding did not become ready${detail}`);
}

interface InstalledTarget {
  renderer: RendererConnection;
  snapshot: RendererCdpControlSnapshot;
  sidecarRelay?: SidecarBindingRelay;
}

interface SidecarBindingRelay {
  activate(): void;
  close(): void;
  deactivate(): void;
  probe(): Promise<void>;
  reinstallBinding(): Promise<void>;
}

interface PendingSidecarProbe {
  reject(error: Error): void;
  resolve(): void;
}

function readSidecarProbeId(payload: string): string | null | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    if (!isRecord(value) || !(SIDECAR_PROBE_KEY in value)) return undefined;
    const probe = value[SIDECAR_PROBE_KEY];
    return isRecord(probe) && probe.version === 1 && typeof probe.id === "string"
      ? probe.id
      : null;
  } catch {
    return undefined;
  }
}

function createSidecarBindingRelay(
  renderer: RendererConnection,
  sidecar: LocalSidecar,
  probeTimeoutMs: number,
): SidecarBindingRelay {
  if (!renderer.on) throw new Error("Renderer CDP binding events are unavailable");
  const pendingProbes = new Map<string, PendingSidecarProbe>();
  let active = false;
  let closed = false;
  let detachSidecar: (() => void) | undefined;
  const deliverSidecarFrame = (frame: string): void => {
    const payload = JSON.stringify(frame);
    void renderer
      .command("Runtime.evaluate", {
        expression: `(() => { const frame = ${payload}; if (typeof window.__harnessmixSidecarReceiveV1 === "function") window.__harnessmixSidecarReceiveV1(frame); else (window.__harnessmixPendingSidecarFramesV1 ??= []).push(frame); })()`,
      })
      .catch(() => undefined);
  };
  const detachBinding = renderer.on("Runtime.bindingCalled", (params) => {
    if (
      !isRecord(params) ||
      params.name !== SIDECAR_BINDING_NAME ||
      typeof params.payload !== "string"
    ) {
      return;
    }
    const probeId = readSidecarProbeId(params.payload);
    if (probeId !== undefined) {
      if (probeId !== null) pendingProbes.get(probeId)?.resolve();
      return;
    }
    if (!active || closed) return;
    try {
      sidecar.send(params.payload);
    } catch (error) {
      deliverSidecarFrame(JSON.stringify({ harnessmixSidecarFailure: String(error) }));
    }
  });
  const deactivate = (): void => {
    active = false;
    detachSidecar?.();
    detachSidecar = undefined;
  };
  return {
    activate() {
      if (closed || active) return;
      active = true;
      detachSidecar = sidecar.onFrame(deliverSidecarFrame);
    },
    close() {
      if (closed) return;
      closed = true;
      deactivate();
      detachBinding();
      for (const probe of pendingProbes.values()) {
        probe.reject(new Error("Renderer CDP sidecar relay is closed"));
      }
      pendingProbes.clear();
    },
    deactivate,
    async probe() {
      if (closed) throw new Error("Renderer CDP sidecar relay is closed");
      const id = `${Date.now().toString(36)}-${(++sidecarProbeSequence).toString(36)}`;
      const envelope = JSON.stringify({
        [SIDECAR_PROBE_KEY]: { version: 1, id },
      });
      let timer: NodeJS.Timeout | undefined;
      const ack = new Promise<void>((resolve, reject) => {
        pendingProbes.set(id, {
          reject(error) {
            pendingProbes.delete(id);
            if (timer) clearTimeout(timer);
            reject(error);
          },
          resolve() {
            pendingProbes.delete(id);
            if (timer) clearTimeout(timer);
            resolve();
          },
        });
        timer = setTimeout(() => {
          pendingProbes
            .get(id)
            ?.reject(new Error("Renderer CDP sidecar binding probe timed out"));
        }, probeTimeoutMs);
      });
      try {
        void renderer
          .command("Runtime.evaluate", {
            expression: `window.${SIDECAR_BINDING_NAME}(JSON.stringify(${envelope}))`,
            awaitPromise: true,
          })
          .then((response) => {
            if (!isRecord(response)) {
              throw new Error("Renderer CDP sidecar binding probe returned an invalid result");
            }
            if (isRecord(response.exceptionDetails)) {
              throw new Error(
                typeof response.exceptionDetails.text === "string"
                  ? response.exceptionDetails.text
                  : "Renderer CDP sidecar binding probe failed",
              );
            }
          })
          .catch((error: unknown) => {
            pendingProbes
              .get(id)
              ?.reject(error instanceof Error ? error : new Error(String(error)));
          });
        await ack;
      } catch (error) {
        pendingProbes.delete(id);
        if (timer) clearTimeout(timer);
        throw error;
      }
    },
    async reinstallBinding() {
      await renderer
        .command("Runtime.removeBinding", { name: SIDECAR_BINDING_NAME })
        .catch(() => undefined);
      await renderer.command("Runtime.addBinding", { name: SIDECAR_BINDING_NAME });
    },
  };
}

async function installTarget(
  target: CdpTarget,
  rendererSource: string,
  sidecar: LocalSidecar | undefined,
  enabledAgents: readonly string[],
  timeoutMs: number,
  pollIntervalMs: number,
  operations: CdpOperations,
  onSidecarRelayReady?: (relay: SidecarBindingRelay) => void,
): Promise<InstalledTarget> {
  const renderer = await operations.connect(target.webSocketDebuggerUrl);
  let sidecarRelay: SidecarBindingRelay | undefined;
  try {
    await renderer.command("Runtime.enable");
    await renderer.command("Page.enable");
    if (sidecar) {
      sidecarRelay = createSidecarBindingRelay(
        renderer,
        sidecar,
        Math.min(MAX_SIDECAR_PROBE_TIMEOUT_MS, Math.max(25, pollIntervalMs * 8)),
      );
      await sidecarRelay.reinstallBinding();
      await sidecarRelay.probe();
      onSidecarRelayReady?.(sidecarRelay);
    }
    await renderer.command("Page.addScriptToEvaluateOnNewDocument", { source: rendererSource });
    await evaluateSource(renderer, rendererSource);
    const draftPrewarmPolicy = await operations.installDraftPrewarmPolicy(renderer);
    const binding = await waitForBinding(renderer, enabledAgents, timeoutMs, pollIntervalMs);
    return {
      renderer,
      snapshot: { target, draftPrewarmPolicy, binding },
      ...(sidecarRelay ? { sidecarRelay } : {}),
    };
  } catch (error) {
    sidecarRelay?.close();
    renderer.close();
    throw error;
  }
}

class ActiveRendererCdpControlSession implements RendererCdpControlSession {
  #closed = false;
  #renderer: RendererConnection;
  #snapshot: RendererCdpControlSnapshot;
  #sidecarRelay: SidecarBindingRelay | undefined;
  #pendingReplacementRelay: SidecarBindingRelay | undefined;
  #lifecycleTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly endpoint: string,
    private readonly rendererSource: string,
    private readonly sidecar: LocalSidecar | undefined,
    private readonly enabledAgents: readonly string[],
    private readonly timeoutMs: number,
    private readonly pollIntervalMs: number,
    private readonly operations: CdpOperations,
    installed: InstalledTarget,
  ) {
    this.#renderer = installed.renderer;
    this.#snapshot = installed.snapshot;
    this.#sidecarRelay = installed.sidecarRelay;
  }

  get snapshot(): RendererCdpControlSnapshot {
    return this.#snapshot;
  }

  ensureInstalled(): Promise<RendererCdpControlSnapshot> {
    const operation = this.#lifecycleTail.then(() => this.#ensureInstalledOnce());
    this.#lifecycleTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #ensureInstalledOnce(): Promise<RendererCdpControlSnapshot> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    const target = await waitForPrimaryTarget(
      this.endpoint,
      this.operations,
      this.timeoutMs,
      this.pollIntervalMs,
      this.#snapshot.target.id,
    );
    if (target.id !== this.#snapshot.target.id) {
      await this.#reinstall(target);
      return this.#snapshot;
    }
    try {
      if (this.#sidecarRelay) {
        try {
          await this.#sidecarRelay.probe();
        } catch {
          await this.#sidecarRelay.reinstallBinding();
          await this.#sidecarRelay.probe();
          recoverPendingApprovals(this.#renderer);
        }
      }
      const existing = await readBinding(this.#renderer);
      if (existing === null) await evaluateSource(this.#renderer, this.rendererSource);
      else validateBindingStatus(existing, this.enabledAgents);
      const draftPrewarmPolicy = await this.operations.installDraftPrewarmPolicy(this.#renderer);
      const binding = await waitForBinding(
        this.#renderer,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
      );
      this.#snapshot = { target, draftPrewarmPolicy, binding };
      return this.#snapshot;
    } catch {
      if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
      await this.#reinstall(target);
      return this.#snapshot;
    }
  }

  async activateDesktop(): Promise<number> {
    if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
    await this.#renderer.command("Page.bringToFront");
    return 1;
  }

  executeRenderer<T>(expression: string): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("Renderer CDP Control Session is closed"));
    }
    return this.#renderer.evaluate<T>(expression);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingReplacementRelay?.close();
    this.#pendingReplacementRelay = undefined;
    this.#sidecarRelay?.close();
    this.#renderer.close();
  }

  async #reinstall(target: CdpTarget): Promise<void> {
    const previousRelay = this.#sidecarRelay;
    let relayHandedOff = false;
    let replacement: InstalledTarget;
    try {
      replacement = await installTarget(
        target,
        this.rendererSource,
        this.sidecar,
        this.enabledAgents,
        this.timeoutMs,
        this.pollIntervalMs,
        this.operations,
        (relay) => {
          if (this.#closed) throw new Error("Renderer CDP Control Session is closed");
          this.#pendingReplacementRelay = relay;
          previousRelay?.deactivate();
          relayHandedOff = true;
          relay.activate();
        },
      );
    } catch (error) {
      this.#pendingReplacementRelay = undefined;
      if (relayHandedOff && !this.#closed) previousRelay?.activate();
      throw error;
    }
    this.#pendingReplacementRelay = undefined;
    if (this.#closed) {
      replacement.sidecarRelay?.close();
      replacement.renderer.close();
      throw new Error("Renderer CDP Control Session is closed");
    }
    previousRelay?.close();
    this.#renderer.close();
    this.#renderer = replacement.renderer;
    this.#sidecarRelay = replacement.sidecarRelay;
    this.#snapshot = replacement.snapshot;
    if (replacement.sidecarRelay) recoverPendingApprovals(replacement.renderer);
  }
}

const liveOperations: CdpOperations = {
  listTargets: (endpoint) => listCdpTargets(endpoint),
  connect: (webSocketDebuggerUrl) => CdpClient.connect(webSocketDebuggerUrl),
  installDraftPrewarmPolicy: installRendererDraftPrewarmPolicyDirect,
};

export async function createRendererCdpControlSession(
  options: CreateSessionOptions,
): Promise<RendererCdpControlSession> {
  const enabledAgents = options.enabledAgents ?? ["codex", "pi"];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const operations = options.operations ?? liveOperations;
  const target = await waitForPrimaryTarget(
    options.rendererCdpEndpoint,
    operations,
    timeoutMs,
    pollIntervalMs,
  );
  const installed = await installTarget(
    target,
    options.rendererSource,
    options.sidecar,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    (relay) => relay.activate(),
  );
  return new ActiveRendererCdpControlSession(
    options.rendererCdpEndpoint,
    options.rendererSource,
    options.sidecar,
    enabledAgents,
    timeoutMs,
    pollIntervalMs,
    operations,
    installed,
  );
}

export function installRendererCdpControlSession(
  options: InstallRendererCdpControlOptions,
): Promise<RendererCdpControlSession> {
  return createRendererCdpControlSession(options);
}

export type RendererCdpFetch = CdpFetch;
export type RendererCdpClientOptions = CdpClientOptions;
