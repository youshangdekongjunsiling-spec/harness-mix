const DESKTOP_26_1106_CFCU_SHA256 =
  '36d8a030eb70b1e49680a36261bce50e93b1d72a6175b9a9abb44d4cb869c3d9';
const FACTORY_START = 'function(e,t,n,i,s,{dispatchMessageFromView:o=';
const FACTORY_END = '}(e,t,e.get(o.n,t),e4.Q.bind(null,e),(e,t)=>e(d.RO,t))';

export interface NativeWebpackRequire {
  (id: string): Record<string, any>;
  m?: Record<string, Function>;
}

export interface NativeRendererScope {
  get(atom: unknown, key?: unknown): any;
  set?: (...args: any[]) => unknown;
  watch?: (...args: any[]) => unknown;
}

export interface NativeRendererManager {
  getHostId(): string;
  sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown> | unknown;
  onNotification(method: string, params: unknown, ...rest: unknown[]): void;
  onRequest(request: Record<string, unknown>): void;
  prewarmedThreadManager?: { discardAllPrewarmedThreads(): void };
  [key: string]: any;
}

type NativeManagerFactory = (
  scope: NativeRendererScope,
  hostId: string,
  requestClient: object,
  captureTurnStartInput: (...args: any[]) => unknown,
  readLatestImageEditTurnState: (...args: any[]) => unknown,
  options?: Record<string, unknown>,
) => NativeRendererManager;

declare global {
  interface Window {
    __harnessmixNativeManagerFactoryV1?: NativeManagerFactory;
    __harnessmixNativeManagerRegistryAtomV1?: unknown;
    __harnessmixNativeManagerFactoryQueueV1?: boolean;
    __harnessmixNativeRequireV1?: NativeWebpackRequire;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return bytesToHex(new Uint8Array(digest));
}

/** Extract the exact factory expression from the reviewed Desktop module. */
export function nativeManagerFactoryExpression(moduleSource: string): string {
  const start = moduleSource.indexOf(FACTORY_START);
  if (start < 0 || moduleSource.indexOf(FACTORY_START, start + 1) >= 0) {
    throw new Error('Desktop native manager factory marker is missing or ambiguous');
  }
  const endMarker = moduleSource.indexOf(FACTORY_END, start);
  if (endMarker < 0 || moduleSource.indexOf(FACTORY_END, endMarker + 1) >= 0) {
    throw new Error('Desktop native manager factory terminator is missing or ambiguous');
  }
  return moduleSource.slice(start, endMarker + 1);
}

export async function loadNativeManagerFactory(
  webpackRequire: NativeWebpackRequire,
): Promise<NativeManagerFactory> {
  if (typeof window.__harnessmixNativeManagerFactoryV1 === 'function') {
    return window.__harnessmixNativeManagerFactoryV1;
  }
  const moduleFactory = webpackRequire.m?.cfCu;
  if (typeof moduleFactory !== 'function') throw new Error('Desktop cfCu module factory is unavailable');
  const source = Function.prototype.toString.call(moduleFactory);
  if (await sha256(source) !== DESKTOP_26_1106_CFCU_SHA256) {
    throw new Error('Desktop native manager factory source is not the reviewed 26.1106 build');
  }
  const callableSource = source.startsWith('cfCu(') ? `function${source.slice(4)}` : source;
  const expression = nativeManagerFactoryExpression(callableSource);
  const injection = `;t.__harnessmixNativeManagerFactoryV1=${expression};`;
  const copiedSource = `${callableSource.slice(0, -1)}${injection}}`;
  let copiedModule: Function;
  try {
    copiedModule = (0, eval)(`(${copiedSource})`) as Function;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Desktop blocked the guarded native manager factory copy${detail}`, { cause: error });
  }
  const exports: Record<string, unknown> = {};
  copiedModule({ exports }, exports, webpackRequire);
  const factory = exports.__harnessmixNativeManagerFactoryV1;
  if (typeof factory !== 'function') throw new Error('Desktop native manager factory export failed');
  return factory as NativeManagerFactory;
}

export function isNativeRendererScope(
  candidate: unknown,
  webpackRequire: NativeWebpackRequire,
): candidate is NativeRendererScope {
  if (!candidate || typeof candidate !== 'object' || typeof (candidate as NativeRendererScope).get !== 'function') {
    return false;
  }
  try {
    const hosts = (candidate as NativeRendererScope).get(webpackRequire('CfsC').D);
    const requestClient = (candidate as NativeRendererScope).get(webpackRequire('x2vX').n, 'local');
    return Array.isArray(hosts) && hosts.includes('local') && typeof requestClient?.sendRequest === 'function';
  } catch {
    return false;
  }
}

export function findNativeRendererScopes(
  root: ParentNode,
  webpackRequire: NativeWebpackRequire,
): NativeRendererScope[] {
  const scopes = new Set<NativeRendererScope>();
  const elements = root.querySelectorAll('*');
  for (const element of elements) {
    const fiberKey = Object.getOwnPropertyNames(element).find((name) => name.startsWith('__reactFiber$'));
    let fiber = fiberKey ? (element as any)[fiberKey] : null;
    for (let depth = 0; fiber && depth < 160; depth += 1, fiber = fiber.return) {
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 120; index += 1, hook = hook.next) {
        const value = hook.memoizedState as { current?: unknown } | null;
        for (const candidate of [value, value?.current]) {
          if (isNativeRendererScope(candidate, webpackRequire)) scopes.add(candidate);
        }
      }
    }
    if (scopes.size > 0) break;
  }
  // Many hooks expose distinct wrappers over the same root scope. The closest
  // validated wrapper is the active renderer scope; do not reject equivalent wrappers.
  return [...scopes].slice(0, 1);
}

export async function createNativeRendererManager(options: {
  webpackRequire: NativeWebpackRequire;
  scope: NativeRendererScope;
  requestClient: object;
  dispatchMessageFromView?: (type: string, payload: unknown) => void;
  dispatchMessageToView?: (payload: unknown) => void;
  queuedMessageStorage?: object;
  queuedMessageCoordination?: object;
  queuedSendLocks?: object;
}): Promise<NativeRendererManager> {
  const { webpackRequire, scope, requestClient } = options;
  if (!isNativeRendererScope(scope, webpackRequire)) throw new Error('Desktop renderer scope is incompatible');
  const factory = await loadNativeManagerFactory(webpackRequire);
  if (options.queuedMessageStorage && window.__harnessmixNativeManagerFactoryQueueV1 !== true) {
    throw new Error('Desktop isolated queue factory has not been installed');
  }
  const captureTurnStartInput = webpackRequire('beL3').Q.bind(null, scope);
  const imageEditAtom = webpackRequire('tl5a').RO;
  const manager = factory(
    scope,
    'local',
    requestClient,
    captureTurnStartInput,
    (get: (atom: unknown, key?: unknown) => unknown, key: unknown) => get(imageEditAtom, key),
    {
      dispatchMessageFromView: options.dispatchMessageFromView,
      dispatchMessageToView: options.dispatchMessageToView,
      suppressResumeHistoryDrain: () => false,
      supportsPaginatedThreadHistory: () => false,
      queuedMessageStorage: options.queuedMessageStorage,
      queuedMessageCoordination: options.queuedMessageCoordination,
      queuedSendLocks: options.queuedSendLocks,
    },
  );
  if (
    !manager || manager.getHostId() !== 'local' || typeof manager.sendRequest !== 'function' ||
    typeof manager.onNotification !== 'function' || typeof manager.onRequest !== 'function'
  ) {
    throw new Error('Desktop native manager factory returned an incompatible manager');
  }
  return manager;
}

/** Use Desktop's own facade and RpcStub; this preserves subscription/then/dup semantics. */
export function createNativeRendererRpc(
  webpackRequire: NativeWebpackRequire,
  manager: NativeRendererManager,
): Record<PropertyKey, any> {
  const RpcStub = webpackRequire('ZG9f').AX;
  const NativeFacade = webpackRequire('K6lt').gR;
  if (typeof RpcStub !== 'function' || typeof NativeFacade !== 'function') {
    throw new Error('Desktop native RPC facade is unavailable');
  }
  const rpc = new RpcStub(new NativeFacade(() => manager));
  if (!rpc || (typeof rpc !== 'object' && typeof rpc !== 'function') ||
      typeof rpc.dup !== 'function' || typeof rpc.subscribe !== 'function') {
    throw new Error('Desktop native RPC facade is incompatible');
  }
  return rpc;
}

/** Native RpcTarget used behind Desktop's own facade/RpcStub boundary. */
export function createNativeTurnCoordinatorTarget(
  webpackRequire: NativeWebpackRequire,
  routedCoordinator: Record<PropertyKey, any>,
  ownedHandles: any[] = [],
): Record<PropertyKey, any> {
  const RpcTarget = webpackRequire('ZG9f').TF;
  if (typeof RpcTarget !== 'function') throw new Error('Desktop native RpcTarget is unavailable');
  class HarnessTurnCoordinatorTarget extends RpcTarget {
    [(Symbol as any).dispose]() {
      for (const handle of ownedHandles) handle?.[(Symbol as any).dispose]?.();
    }
    get sendMessage() { return (...args: any[]) => routedCoordinator.sendMessage(...args); }
    get deferAutomaticTurns() { return (...args: any[]) => routedCoordinator.deferAutomaticTurns(...args); }
    get sendQueuedMessageNow() { return (...args: any[]) => routedCoordinator.sendQueuedMessageNow(...args); }
    get removeQueuedMessage() { return (...args: any[]) => routedCoordinator.removeQueuedMessage(...args); }
    get clearQueuedMessages() { return (...args: any[]) => routedCoordinator.clearQueuedMessages(...args); }
    get restoreQueuedMessage() { return (...args: any[]) => routedCoordinator.restoreQueuedMessage(...args); }
    get reorderQueuedMessages() { return (...args: any[]) => routedCoordinator.reorderQueuedMessages(...args); }
    get resumeInterruptedQueuedMessages() {
      return (...args: any[]) => routedCoordinator.resumeInterruptedQueuedMessages(...args);
    }
    registerReplayAdmission(...args: any[]) { return routedCoordinator.registerReplayAdmission(...args); }
    subscribeOpeningTurnContext(...args: any[]) {
      return routedCoordinator.subscribeOpeningTurnContext(...args);
    }
  }
  const RpcStub = webpackRequire('ZG9f').AX;
  return new RpcStub(new HarnessTurnCoordinatorTarget());
}

/** Preserve native handle semantics for combined RPC subscriptions. */
export function createNativeSubscriptionRpc(
  webpackRequire: NativeWebpackRequire,
  handles: any[],
): Record<PropertyKey, any> {
  const { TF: RpcTarget, AX: RpcStub } = webpackRequire('ZG9f');
  const dispose = (Symbol as any).dispose;
  class CombinedSubscription extends RpcTarget {
    closed = false;
    unsubscribe() {
      if (this.closed) return;
      this.closed = true;
      for (const handle of handles) {
        if (typeof handle?.[dispose] === 'function') handle[dispose]();
        else if (typeof handle === 'function') handle();
      }
    }
    [dispose]() { this.unsubscribe(); }
  }
  return new RpcStub(new CombinedSubscription());
}
