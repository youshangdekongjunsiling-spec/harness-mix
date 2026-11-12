type RpcLike = Record<PropertyKey, any>;
const disposeSymbol: symbol = (Symbol as unknown as { dispose?: symbol }).dispose ??
  Symbol.for('Symbol.dispose');

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rpcThreadId(args: readonly unknown[]): string | null {
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 4 || !isRecord(value)) return null;
    for (const key of ['threadId', 'conversationId']) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
    if (isRecord(value.key)) {
      const nested = visit(value.key, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  for (const arg of args) {
    const found = visit(arg, 0);
    if (found) return found;
  }
  return null;
}

const THREAD_FIRST_ARGUMENT_METHODS = new Set([
  'activateThreadSummary', 'archiveConversation', 'cleanBackgroundTerminals', 'compactThread',
  'deleteConversation', 'discardConversationFromCache', 'discardConversationIfEmpty',
  'editLastUserTurn', 'ensureConversationFirstPage', 'ensureSubagentPreviewFirstPage',
  'forkConversationFromLatest', 'forkConversationFromTurn', 'getConversation',
  'getConversationAncestry', 'getConversationCwd', 'getConversationEnvironments',
  'getConversationOpeningContext', 'getConversationTitleInput', 'getCurrentPermissions',
  'getDaybreakInheritanceSource', 'getFollowUpContext', 'getLatestTurnId',
  'getLatestTurnMessages', 'getLoadedConversationHistory', 'getLoadedTurnClientMessageIds',
  'getNavigationRuntimeState', 'getRealtimePromotionHistory', 'getRecentTurnMessageContext',
  'getStreamRole', 'getThreadExecutionState', 'getThreadWritableRoots', 'getTurnDiffContext',
  'getTurnEnvironmentContext', 'getTurnModelContext', 'hydrateArchivedThreadPreview',
  'interruptConversation', 'interruptConversationWithOutcome', 'interruptSubagentDescendants',
  'isConversationArchiving', 'listAttachedThreads', 'listThreadItems', 'listThreadTurns',
  'loadBackgroundThreadHistoryPage', 'markConversationAsRead', 'markConversationAsUnread',
  'prefetchSharedThreadTurns', 'readConversationContext', 'readRecentThreadMessages',
  'readThread', 'recordAeonAssistantMessageDelivery', 'recordUnreadMessage',
  'resumeConversation', 'resumeThread', 'retainActiveConversation', 'retrySafetyBufferedTurn',
  'runThreadModelSettingsUpdate', 'sendFollowUpMessage', 'setThreadGoal', 'setThreadGoalStatus',
  'setThreadStartKind', 'setThreadTitle', 'startEmptyTurn', 'startTurn', 'startTurnWithOutcome',
  'steerTurn', 'stopThread', 'unsubscribeInactiveConversation', 'updateLegacyEnvironmentConnection',
  'updateThreadDaybreakEnabled', 'updateThreadGitBranch', 'updateThreadPermissions',
  'updateThreadSettingsForNextTurn',
]);

function mergeIds(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) return [...new Set([...left, ...right])];
  if (isRecord(left) && isRecord(right) && Array.isArray(left.all) && Array.isArray(right.all)) {
    return {
      ...left,
      ...right,
      all: [...new Set([...left.all, ...right.all])],
      topLevel: [...new Set([...(left.topLevel ?? []), ...(right.topLevel ?? [])])],
    };
  }
  return right ?? left;
}

const DUAL_AGGREGATE_METHODS = new Set([
  'loadRecentConversationIds', 'refreshRecentConversations', 'searchThreads',
]);

function mergeAggregateResults(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) return [...new Set([...left, ...right])];
  if (typeof left === 'number' && typeof right === 'number') return left + right;
  if (isRecord(left) && isRecord(right) && Array.isArray(left.data) && Array.isArray(right.data)) {
    return { ...left, ...right, data: [...left.data, ...right.data] };
  }
  return right ?? left;
}

/** Composite native RPC: official is the default; only proven external IDs route away. */
export function createNativeCompositeRpc(
  official: RpcLike,
  external: RpcLike,
  externalThreadIds: Pick<ReadonlySet<string>, 'has'>,
  options: {
    isExternalSelected?: () => boolean;
    externalStartModel?: () => string | null;
    routeTurnCoordinator?: boolean;
    createTurnCoordinatorTarget?: (official: RpcLike, external: RpcLike) => RpcLike;
    combineSubscriptions?: (handles: any[]) => RpcLike;
  } = {},
): RpcLike {
  const methodCache = new Map<PropertyKey, unknown>();
  let turnCoordinatorComposite: RpcLike | null = null;
  const lazyResumes = new Map<string, Promise<unknown>>();
  const diagnostics: Array<{
    method: string;
    route: 'official' | 'external' | 'split' | 'blocked-external-prewarm' | 'dual';
    args: string[];
    hasKnownThread: boolean;
  }> = [];
  const describeArg = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `array:${value.length}:${value.every((entry) => typeof entry === 'string') ? 'strings' : 'mixed'}`;
    }
    if (isRecord(value)) return `object:${Object.keys(value).sort().slice(0, 12).join(',')}`;
    return typeof value;
  };
  const recordRoute = (
    property: PropertyKey,
    args: readonly unknown[],
    route: 'official' | 'external' | 'split' | 'blocked-external-prewarm' | 'dual',
    threadId: string | null,
  ): void => {
    diagnostics.push({
      method: String(property), route, args: args.map(describeArg),
      hasKnownThread: threadId !== null && externalThreadIds.has(threadId),
    });
    if (diagnostics.length > 96) diagnostics.shift();
  };
  let composite: RpcLike;
  const handler: ProxyHandler<RpcLike> = {
    get(_target, property) {
      if (property === '__harnessmixNativeCompositeV1') return true;
      if (property === '__harnessmixOfficialRpcV1') return official;
      if (property === '__harnessmixDiagnosticsV1') return () => diagnostics.map((entry) => ({ ...entry, args: [...entry.args] }));
      if (property === 'dup') return () => composite;
      if (property === disposeSymbol) {
        return () => undefined;
      }
      if (methodCache.has(property)) return methodCache.get(property);
      const officialValue = Reflect.get(official, property, official);
      const externalValue = Reflect.get(external, property, external);
      if (property === 'turnCoordinator' && options.routeTurnCoordinator &&
          officialValue && externalValue) {
        if (!turnCoordinatorComposite) {
          const createTarget = options.createTurnCoordinatorTarget;
          if (!createTarget) throw new Error('Desktop native turn coordinator target factory is unavailable');
          turnCoordinatorComposite = createTarget(officialValue, externalValue);
        }
        return turnCoordinatorComposite;
      }
      if (typeof officialValue !== 'function') return officialValue;
      const method = (...args: unknown[]) => {
        if (property === 'getTurnCoordinator' && options.routeTurnCoordinator && args.length === 0 &&
            typeof externalValue === 'function') {
          {
            const officialCoordinator = Reflect.apply(officialValue, official, []);
            const externalCoordinator = Reflect.apply(externalValue, external, []);
            if (!officialCoordinator || !externalCoordinator) {
              throw new Error('Desktop native turn coordinator is unavailable');
            }
            // The facade acquires a coordinator before it has a thread ID. Its
            // coordinator methods (sendMessage, retry/remove/reorder, etc.) do
            // carry the conversation ID, so preserve that native object shape
            // and defer the ownership decision to this second composite.
            const createTarget = options.createTurnCoordinatorTarget;
            if (!createTarget) throw new Error('Desktop native turn coordinator target factory is unavailable');
            const result = createTarget(officialCoordinator, externalCoordinator);
            recordRoute(property, args, 'dual', null);
            return result;
          }
        }
        if ((property === 'registerReplayAdmission' || property === 'subscribeOpeningTurnContext') &&
            typeof externalValue === 'function') {
          const left: any = Reflect.apply(officialValue, official, args);
          const right: any = Reflect.apply(externalValue, external, args);
          if (options.combineSubscriptions) {
            recordRoute(property, args, 'dual', null);
            return options.combineSubscriptions([left, right]);
          }
          const dispose = (): void => {
            if (typeof left?.[disposeSymbol] === 'function') left[disposeSymbol]();
            else if (typeof left === 'function') left();
            if (typeof right?.[disposeSymbol] === 'function') right[disposeSymbol]();
            else if (typeof right === 'function') right();
          };
          Object.defineProperty(dispose, disposeSymbol, { value: dispose });
          recordRoute(property, args, 'dual', null);
          return dispose;
        }
        const threadId = rpcThreadId(args) ??
          (typeof args[0] === 'string' && externalThreadIds.has(args[0]) ? args[0] :
            THREAD_FIRST_ARGUMENT_METHODS.has(String(property)) && typeof args[0] === 'string'
              ? args[0] : null);
        if (threadId && externalThreadIds.has(threadId)) {
          if (typeof externalValue !== 'function') throw new Error(`External native RPC lacks ${String(property)}`);
          recordRoute(property, args, 'external', threadId);
          if (property === 'getNavigationRuntimeState') {
            const state = Reflect.apply(externalValue, external, args);
            const resolveNavigationState = (resolvedState: unknown): unknown => {
              if (resolvedState === 'cold' && !lazyResumes.has(threadId) &&
                  typeof external.hydrateBackgroundThreads === 'function' &&
                  typeof external.ensureConversationHistoryLoaded === 'function') {
                // Exact public sequence verified against the shipped manager.
                // Do not reconstruct its private structured resume request.
                const work = Promise.resolve(
                  Reflect.apply(external.hydrateBackgroundThreads, external, [[threadId]]),
                ).then(() => Reflect.apply(
                  external.ensureConversationHistoryLoaded, external, [threadId],
                ))
                  .catch((error: unknown) => {
                    console.error(
                      'harnessmix external conversation hydration failed',
                      error instanceof Error ? error.name : 'UnknownError',
                    );
                  })
                  .finally(() => lazyResumes.delete(threadId));
                lazyResumes.set(threadId, work);
                // Native navigation has no external resume coordinator. Report
                // the real in-flight state while the shipped external manager
                // performs its own deduplicated thread/resume and reducers.
                return 'unknown';
              }
              return lazyResumes.has(threadId) ? 'unknown' : resolvedState;
            };
            const thenable = state as { then?: unknown } | null;
            return thenable && typeof thenable.then === 'function'
              ? Promise.resolve(state).then(resolveNavigationState)
              : resolveNavigationState(state);
          }
          return Reflect.apply(externalValue, external, args);
        }
        if (Array.isArray(args[0]) && args[0].every((value) => typeof value === 'string') &&
            typeof externalValue === 'function') {
          const externalIds = args[0].filter((id) => externalThreadIds.has(id));
          if (externalIds.length > 0) {
            const officialIds = args[0].filter((id) => !externalThreadIds.has(id));
            const work: unknown[] = [];
            recordRoute(property, args, 'split', externalIds[0] ?? null);
            if (officialIds.length > 0) work.push(Reflect.apply(officialValue, official, [officialIds, ...args.slice(1)]));
            work.push(Reflect.apply(externalValue, external, [externalIds, ...args.slice(1)]));
            return Promise.all(work);
          }
        }
        if ((property === 'prewarmConversation' || property === 'prewarmCloudConversation') &&
            options.isExternalSelected?.()) {
          recordRoute(property, args, 'blocked-external-prewarm', threadId);
          return Promise.resolve(null);
        }
        if ((property === 'prepareThreadStart' || property === 'startConversation') &&
            options.isExternalSelected?.()) {
          if (typeof externalValue !== 'function') throw new Error(`External native RPC lacks ${String(property)}`);
          recordRoute(property, args, 'external', threadId);
          // Creation awaits attachment preparation and UI navigation. Bind the
          // selected carrier to this request before those callbacks clear the
          // draft policy; never consult another composer's later selection.
          const carrier = options.externalStartModel?.();
          if (carrier && isRecord(args[0])) {
            const params = args[0];
            args = [{ ...params, model: carrier,
              collaborationMode: params.collaborationMode ? {
                ...params.collaborationMode,
                settings: { ...params.collaborationMode.settings, model: carrier },
              } : params.collaborationMode,
            }, ...args.slice(1)];
          }
          return Reflect.apply(externalValue, external, args);
        }
        if (DUAL_AGGREGATE_METHODS.has(String(property)) && typeof externalValue === 'function') {
          recordRoute(property, args, 'dual', threadId);
          const officialResult = Reflect.apply(officialValue, official, args);
          let externalResult: unknown;
          try {
            externalResult = Reflect.apply(externalValue, external, args);
          } catch {
            // A disconnected sidecar must not break the stock conversation list.
            return officialResult;
          }
          return Promise.resolve(officialResult).then(async (left) => {
            try {
              return mergeAggregateResults(left, await externalResult);
            } catch {
              return left;
            }
          });
        }
        if (property === 'subscribe' && isRecord(args[0])) {
          const descriptor = args[0];
          const keyThreadId = rpcThreadId([descriptor.key]);
          const dualEvents = descriptor.type === 'event' || descriptor.type === 'notification';
          const mergesThreadIds = descriptor.type === 'host' && descriptor.field === 'threadSummaryIds';
          if (!keyThreadId && (dualEvents || mergesThreadIds) && typeof descriptor.listener === 'function' &&
              typeof externalValue === 'function') {
            let officialSnapshot: unknown;
            let externalSnapshot: unknown;
            const listener = descriptor.listener as (value: unknown) => void;
            const left: any = Reflect.apply(officialValue, official, [{ ...descriptor, listener(value: unknown) {
              officialSnapshot = value;
              listener(mergesThreadIds ? mergeIds(officialSnapshot, externalSnapshot) : value);
            } }]);
            const right: any = Reflect.apply(externalValue, external, [{ ...descriptor, listener(value: unknown) {
              externalSnapshot = value;
              listener(mergesThreadIds ? mergeIds(officialSnapshot, externalSnapshot) : value);
            } }]);
            const settled = {
              [disposeSymbol]() { left?.[disposeSymbol]?.(); right?.[disposeSymbol]?.(); },
              onRpcBroken(listener: (...args: unknown[]) => void) {
                left?.onRpcBroken?.(listener);
                right?.onRpcBroken?.(listener);
              },
            };
            recordRoute(property, args, 'dual', keyThreadId);
            return {
              ...settled,
              then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
                return Promise.all([Promise.resolve(left), Promise.resolve(right)]).then(
                  () => resolve(settled), reject,
                );
              },
            };
          }
        }
        recordRoute(property, args, 'official', threadId);
        return Reflect.apply(officialValue, official, args);
      };
      methodCache.set(property, method);
      return method;
    },
  };
  composite = new Proxy({}, handler);
  return composite;
}
