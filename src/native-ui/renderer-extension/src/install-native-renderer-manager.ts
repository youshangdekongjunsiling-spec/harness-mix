import { createNativeCompositeRpc } from './native-composite-rpc.js';
import {
  createNativeRendererManager,
  createNativeRendererRpc,
  createNativeTurnCoordinatorTarget,
  createNativeSubscriptionRpc,
  findNativeRendererScopes,
  type NativeRendererManager,
  type NativeWebpackRequire,
} from './native-renderer-manager.js';
import { createNativeSidecarRequestClient } from './native-sidecar-request-client.js';
import { installNativeApprovalAcknowledgementGate } from './native-manager-approval-gate.js';
import {
  createNativeQueuedMessageStorage,
  createNativeQueueCoordination,
  migrateExternalQueuedMessages,
} from './native-queued-message-storage.js';

interface RpcHookValue { hostId: string; rpc: Record<PropertyKey, any> }

declare global {
  interface Window {
    __harnessmixSidecarModeV1?: boolean;
    __harnessmixSidecarSendV1?: (frame: string) => void;
    __harnessmixSidecarReceiveV1?: (frame: string) => void;
    __harnessmixPendingSidecarFramesV1?: string[];
    __harnessmixNativeManagerBindingV1?: NativeManagerBinding;
    __harnessmixRequestBridgeV1?: unknown;
  }
}

export interface NativeManagerBinding {
  state: 'ready';
  reason: 'native-renderer-manager';
  manager: NativeRendererManager;
  dispose(): void;
}

function fiberHookValues(root: ParentNode): unknown[] {
  const values: unknown[] = [];
  const visited = new Set<object>();
  for (const element of root.querySelectorAll('*')) {
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key ? (element as any)[key] : null;
    for (let depth = 0; fiber && depth < 160; depth += 1, fiber = fiber.return) {
      if (visited.has(fiber)) break;
      visited.add(fiber);
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 120; index += 1, hook = hook.next) values.push(hook.memoizedState);
    }
  }
  return values;
}

export function findNativeRpcHookValues(root: ParentNode): RpcHookValue[] {
  const values = new Set<RpcHookValue>();
  for (const value of fiberHookValues(root)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as RpcHookValue;
    if (
      candidate.hostId === 'local' && candidate.rpc &&
      (typeof candidate.rpc === 'object' || typeof candidate.rpc === 'function') &&
      (typeof candidate.rpc.subscribe === 'function' || typeof candidate.rpc.getThreadListSummary === 'function')
    ) values.add(candidate);
  }
  return [...values];
}

async function desktopRequire(): Promise<NativeWebpackRequire> {
  // This exact asset and module digest are pinned by native-renderer-manager.ts.
  const assetUrl = 'app://-/assets/348410.1a97dde15f.js';
  const module = await import(/* @vite-ignore */ assetUrl);
  if (typeof module.__webpack_require__ !== 'function') throw new Error('Desktop webpack runtime is unavailable');
  return module.__webpack_require__ as NativeWebpackRequire;
}

export async function installNativeRendererManager(
  publishRendererBinding?: () => void,
): Promise<NativeManagerBinding | null> {
  if (window.__harnessmixSidecarModeV1 !== true) return null;
  // Keep the rejected panel alive only as a migration fence while the native
  // manager performs its asynchronous catalog handshake. The cached previous
  // controller otherwise sees neither its panel nor the new binding and
  // immediately evaluates its old bundle again. The handoff is completed
  // synchronously at the end of this function, immediately before the caller
  // publishes the original Renderer binding in the same microtask checkpoint.
  const legacyPanel = (window as typeof window & {
    __harnessmixIndependentPanelV1?: { dispose(): void };
  }).__harnessmixIndependentPanelV1;
  // Keep an already-working native binding alive throughout an upgrade. Its
  // receiver and atom client are replaced only after the new manager is fully
  // constructed; disposing it up front creates an installing/null window that
  // lets a cached legacy controller resurrect the rejected panel.
  const previousNativeBinding = window.__harnessmixNativeManagerBindingV1;
  if (typeof window.__harnessmixSidecarSendV1 !== 'function') {
    throw new Error('Harness sidecar binding is unavailable');
  }
  const webpackRequire = await desktopRequire();
  const scopes = findNativeRendererScopes(document, webpackRequire);
  if (scopes.length !== 1) throw new Error('Desktop renderer scope is ambiguous');
  const scope = scopes[0]!;
  const connectionAtom = webpackRequire('l00C').M4;
  if (!connectionAtom || typeof scope.set !== 'function' || typeof scope.watch !== 'function') {
    throw new Error('Desktop native host-state registry is unavailable');
  }
  const observedConnection = scope.get(connectionAtom, 'local');
  const observedRpc = observedConnection?.client?.rpc;
  const stockRpc = observedRpc?.__harnessmixNativeCompositeV1 === true
    ? observedRpc.__harnessmixOfficialRpcV1 : observedRpc;
  if (observedConnection?.status !== 'ready' || observedConnection.client?.hostId !== 'local' ||
      !stockRpc || (typeof stockRpc !== 'object' && typeof stockRpc !== 'function') ||
      typeof stockRpc.sendRequest !== 'function') {
    throw new Error('Desktop official native RPC is unavailable');
  }
  const initialConnection = {
    ...observedConnection,
    client: { ...observedConnection.client, rpc: stockRpc },
  };
  let officialRpc = initialConnection.client.rpc as Record<PropertyKey, any>;
  let selectedModel: string | null = null;
  let selectedAccountId: string | null = null;
  const transport = createNativeSidecarRequestClient(
    (frame) => window.__harnessmixSidecarSendV1!(frame),
    {
      selectedModel: () => selectedModel,
      selectedAccountId: () => selectedAccountId,
      nativeMetadataRequest: (method, params, options) =>
        Promise.resolve(officialRpc.sendRequest(method, params, options)),
    },
  );
  let previousReceiver = window.__harnessmixSidecarReceiveV1;
  window.__harnessmixSidecarReceiveV1 = transport.receive;
  for (const frame of window.__harnessmixPendingSidecarFramesV1?.splice(0) ?? []) transport.receive(frame);
  const restoreReceiver = (): void => {
    if (window.__harnessmixSidecarReceiveV1 !== transport.receive) return;
    if (previousReceiver) window.__harnessmixSidecarReceiveV1 = previousReceiver;
    else delete window.__harnessmixSidecarReceiveV1;
  };
  const dispatchMessageFromView = (type: string, payload: any): void => {
    if (type === 'mcp-response' && payload?.response) {
      // The manager fields are replaced below with the Promise-returning path;
      // this fallback is retained only for non-approval Desktop messages.
      void transport.respond(payload.requestMethod ?? 'unknown', payload.response);
      return;
    }
    window.dispatchEvent(new MessageEvent('message', {
      data: { type, ...payload }, origin: window.location.origin, source: window,
    }));
  };
  const catalogThreads: unknown[] = [];
  try {
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const result = await transport.sendRequest('thread/list', {
          archived, limit: 100, ...(cursor ? { cursor } : {}),
        });
        if (!archived && Array.isArray(result?.data)) catalogThreads.push(...result.data);
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
        if (!cursor) break;
        if (page === 99) throw new Error('External thread catalog exceeds the guarded pagination limit');
      }
    }
  } catch (error) {
    restoreReceiver();
    transport.dispose();
    throw error;
  }
  const queuedMessageStorage = createNativeQueuedMessageStorage(webpackRequire);
  try {
    await migrateExternalQueuedMessages({
      webpackRequire, scope, storage: queuedMessageStorage, ownsThread: transport.ownsThread,
    });
  } catch (error) {
    restoreReceiver();
    transport.dispose();
    throw error;
  }
  const queueCoordination = createNativeQueueCoordination(transport.ownsThread);
  let manager: NativeRendererManager;
  try {
    manager = await createNativeRendererManager({
      webpackRequire,
      scope,
      requestClient: transport,
      dispatchMessageFromView,
      dispatchMessageToView: (payload) => window.dispatchEvent(new MessageEvent('message', {
        data: payload, origin: window.location.origin, source: window,
      })),
      queuedMessageStorage,
      queuedMessageCoordination: queueCoordination.queuedMessageCoordination,
      queuedSendLocks: queueCoordination.queuedSendLocks,
    });
  } catch (error) {
    queueCoordination.dispose();
    restoreReceiver();
    transport.dispose();
    throw error;
  }
  manager.sendAppServerResponse = (method: string, response: Record<string, any>) =>
    transport.respond(method, response);
  manager.sendApprovalResponse = manager.sendAppServerResponse;
  const disposeApprovalGate = installNativeApprovalAcknowledgementGate(
    manager,
    (method, response) => transport.respond(method, response),
  );
  transport.setHandlers({
    onNotification: (method, params) => manager.onNotification(method, params),
    onRequest: (request) => manager.onRequest(request),
  });
  let externalRpc: Record<PropertyKey, any>;
  try {
    externalRpc = createNativeRendererRpc(webpackRequire, manager);
  } catch (error) {
    disposeApprovalGate();
    webpackRequire('K6lt').O3.dispose(manager);
    queueCoordination.dispose();
    restoreReceiver();
    transport.dispose();
    throw error;
  }
  let nativeDisposed = false;
  const disposeNative = (): void => {
    if (nativeDisposed) return;
    nativeDisposed = true;
    disposeApprovalGate();
    const dispose = (Symbol as any).dispose;
    if (dispose) externalRpc[dispose]?.();
    webpackRequire('K6lt').O3.dispose(manager);
    queueCoordination.dispose();
  };
  // Seed the original native thread store before exposing the composite RPC;
  // otherwise existing external IDs look unknown and would fall through to Codex.
  try {
    manager.threadStore?.observeCatalogThreads?.(catalogThreads);
  } catch (error) {
    disposeNative();
    restoreReceiver();
    transport.dispose();
    throw error;
  }
  type ConnectionState = { status: string; client?: { hostId?: string; rpc?: Record<PropertyKey, any> } };
  let latestBaseConnection = initialConnection as ConnectionState;
  let currentComposite: Record<PropertyKey, any> | null = null;
  let applyingConnection = false;
  const isReadyOfficialConnection = (value: any): value is ConnectionState & {
    client: { hostId: string; rpc: Record<PropertyKey, any> };
  } => value?.status === 'ready' && value.client?.hostId === 'local' && value.client.rpc &&
    (typeof value.client.rpc === 'object' || typeof value.client.rpc === 'function') &&
    typeof value.client.rpc.sendRequest === 'function';
  const composeRpc = (stock: Record<PropertyKey, any>): Record<PropertyKey, any> => {
    return createNativeCompositeRpc(
      stock,
      externalRpc,
      { has: transport.ownsThread },
      { isExternalSelected: () =>
        selectedModel?.startsWith('harnessmix/') === true || selectedAccountId !== null,
        externalStartModel: () => selectedModel,
        routeTurnCoordinator: true,
        createTurnCoordinatorTarget: (left, right) => createNativeTurnCoordinatorTarget(
          webpackRequire,
          createNativeCompositeRpc(left, right, { has: transport.ownsThread }),
          [left, right],
        ),
        combineSubscriptions: (handles) => createNativeSubscriptionRpc(webpackRequire, handles),
      },
    );
  };
  const installCompositeConnection = (connection: unknown): void => {
    if (!isReadyOfficialConnection(connection)) return;
    if (connection.client.rpc.__harnessmixNativeCompositeV1 === true) return;
    latestBaseConnection = connection;
    officialRpc = connection.client.rpc;
    currentComposite = composeRpc(officialRpc);
    applyingConnection = true;
    try {
      scope.set!(connectionAtom, 'local', {
        ...connection,
        client: { ...connection.client, rpc: currentComposite },
      });
    } finally {
      applyingConnection = false;
    }
  };
  let stopConnectionWatch: unknown;
  try {
    installCompositeConnection(initialConnection);
    if (!currentComposite) throw new Error('Desktop native host-state registry is not ready');
    stopConnectionWatch = scope.watch!(({ get }: { get(atom: unknown, key?: unknown): any }) => {
      const connection = get(connectionAtom, 'local');
      if (!applyingConnection && connection?.client?.rpc !== currentComposite) {
        installCompositeConnection(connection);
      }
    });
  } catch (error) {
    const current = scope.get(connectionAtom, 'local');
    if (current?.client?.rpc === currentComposite) scope.set(connectionAtom, 'local', latestBaseConnection);
    disposeNative();
    restoreReceiver();
    transport.dispose();
    throw error;
  }
  const disposeConnectionWatch = (): void => {
    if (typeof stopConnectionWatch === 'function') stopConnectionWatch();
    else {
      const dispose = (Symbol as any).dispose;
      if (dispose) (stopConnectionWatch as any)?.[dispose]?.();
    }
  };
  // New Desktop execution prefers Dgwo.p.forHost over l00C.M4. Both
  // entry points must share ownership routing; leaving this registry stock
  // silently creates official threads even when the draft selected Claude.
  const executionAtom = webpackRequire('Dgwo').p;
  let baseRegistry: any;
  let routedRegistry: any;
  let applyingRegistry = false;
  const installRegistry = (registry: any): void => {
    if (!registry || typeof registry.forHost !== 'function' || registry === routedRegistry) return;
    if (registry.__harnessmixExecutionRegistryV1 === true) registry = registry.__harnessmixBaseRegistryV1;
    baseRegistry = registry;
    const cache = new WeakMap<object, Record<PropertyKey, any>>();
    routedRegistry = {
      ...registry,
      __harnessmixExecutionRegistryV1: true,
      __harnessmixBaseRegistryV1: registry,
      forHost(hostId: string) {
        const stock = registry.forHost(hostId);
        if (hostId !== 'local') return stock;
        let routed = cache.get(stock);
        if (!routed) { routed = composeRpc(stock); cache.set(stock, routed); }
        return routed;
      },
    };
    applyingRegistry = true;
    try { scope.set!(executionAtom, routedRegistry); }
    finally { applyingRegistry = false; }
  };
  installRegistry(scope.get(executionAtom));
  const stopRegistryWatch = scope.watch!(({ get }: { get(atom: unknown): any }) => {
    const registry = get(executionAtom);
    if (!applyingRegistry && registry !== routedRegistry && registry?.__harnessmixExecutionRegistryV1 !== true) installRegistry(registry);
  });
  const disposeExecutionRegistry = (): void => {
    if (typeof stopRegistryWatch === 'function') stopRegistryWatch();
    else (stopRegistryWatch as any)?.[(Symbol as any).dispose]?.();
    if (scope.get(executionAtom) === routedRegistry) scope.set!(executionAtom, baseRegistry);
  };
  const previousBridge = window.__harnessmixRequestBridgeV1;
  const previousPolicy = window.__harnessmixDraftPrewarmPolicyV1;
  const policy = Object.freeze({
    state: 'ready' as const,
    hostId: 'local',
    requestTarget: () => manager,
    owns(
      candidateManager: unknown,
      candidateBridge: unknown,
      candidateHostId: string,
      candidatePrewarmedThreadManager: unknown,
    ) {
      return candidateManager === manager && candidateBridge === transport &&
        candidateHostId === 'local' &&
        candidatePrewarmedThreadManager === manager.prewarmedThreadManager;
    },
    select(model: string | null) {
      if (model !== null && !model.startsWith('harnessmix/')) throw new Error('External route is required');
      if (selectedModel === model) return false;
      selectedModel = model;
      return true;
    },
    selectAccount(accountId: string | null) {
      if (accountId !== null && !/^[A-Za-z0-9._~-]+$/u.test(accountId)) {
        throw new Error('Harness account ID is invalid');
      }
      if (selectedAccountId === accountId) return false;
      selectedAccountId = accountId;
      return true;
    },
    clear() {
      officialRpc.clearPrewarmedThreads?.();
      manager.prewarmedThreadManager?.discardAllPrewarmedThreads();
      return Promise.resolve();
    },
  });
  window.__harnessmixDraftPrewarmPolicyV1 = policy;
  window.dispatchEvent(new CustomEvent('harnessmix:draft-prewarm-policy-changed'));
  window.__harnessmixRequestBridgeV1 = {
    manager,
    bridge: transport,
    hostId: 'local',
    prewarmedThreadManager: manager.prewarmedThreadManager,
  };
  let disposed = false;
  const binding: NativeManagerBinding = {
    state: 'ready', reason: 'native-renderer-manager', manager,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeExecutionRegistry();
      disposeConnectionWatch();
      const current = scope.get(connectionAtom, 'local');
      if (current?.client?.rpc === currentComposite) {
        scope.set!(connectionAtom, 'local', latestBaseConnection);
      }
      if (window.__harnessmixSidecarReceiveV1 === transport.receive) {
        restoreReceiver();
      }
      if (window.__harnessmixDraftPrewarmPolicyV1 === policy) {
        if (previousPolicy) window.__harnessmixDraftPrewarmPolicyV1 = previousPolicy;
        else delete window.__harnessmixDraftPrewarmPolicyV1;
        window.dispatchEvent(new CustomEvent('harnessmix:draft-prewarm-policy-changed'));
      }
      const exposed = window.__harnessmixRequestBridgeV1 as { manager?: unknown } | undefined;
      if (exposed?.manager === manager) {
        if (previousBridge !== undefined) window.__harnessmixRequestBridgeV1 = previousBridge;
        else delete window.__harnessmixRequestBridgeV1;
      }
      disposeNative();
      transport.dispose();
      if (window.__harnessmixNativeManagerBindingV1 === binding) delete window.__harnessmixNativeManagerBindingV1;
    },
  };
  window.__harnessmixNativeManagerBindingV1 = binding;
  if (publishRendererBinding) {
    try {
      // Publish the original picker while the legacy panel is still a valid
      // status surface for its cached controller. This creates an overlap,
      // never a gap, between old and new controller generations.
      publishRendererBinding();
      if (legacyPanel && window.__harnessmixRendererBindingProbeV1?.status().adapter.state !== 'ready') {
        throw new Error('Original Renderer binding is not ready for legacy handoff');
      }
    } catch (error) {
      window.__harnessmixRendererBindingProbeV1?.dispose();
      binding.dispose();
      throw error;
    }
  }
  if (legacyPanel) {
    // Its receive callback is disposed and must never be restored when the
    // native binding later tears down.
    legacyPanel.dispose();
    previousReceiver = undefined;
  }
  previousNativeBinding?.dispose();
  for (const orphan of document.querySelectorAll('[data-harnessmix-independent-panel]')) {
    orphan.remove();
  }
  return binding;
}
