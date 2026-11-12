import type { NativeRendererScope, NativeWebpackRequire } from './native-renderer-manager.js';

type QueueState = Record<string, any>;
export interface NativeQueuedMessageStorage {
  readQueuedFollowUps(): { isLoading: false; value: QueueState };
  loadQueuedFollowUps(): Promise<QueueState>;
  updateQueuedFollowUps(update: (state: QueueState) => QueueState): Promise<void>;
  subscribeQueuedFollowUps(listener: () => void): () => void;
}
const STORAGE_KEY = 'harnessmix.native.queued-follow-ups.v1';
const asState = (value: unknown): QueueState =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as QueueState : {};

export function createNativeQueuedMessageStorage(
  webpackRequire: NativeWebpackRequire,
): NativeQueuedMessageStorage {
  const nativeStorage = webpackRequire('kpIY');
  if (typeof nativeStorage.TB !== 'function' || typeof nativeStorage.jx !== 'function') {
    throw new Error('Desktop durable storage is unavailable for the Harness queue');
  }
  let state = asState(nativeStorage.TB(STORAGE_KEY, {}));
  let pending = Promise.resolve();
  const listeners = new Set<() => void>();
  return {
    readQueuedFollowUps: () => {
      state = asState(nativeStorage.TB(STORAGE_KEY, {}));
      return { isLoading: false, value: state };
    },
    loadQueuedFollowUps: async () => {
      state = asState(nativeStorage.TB(STORAGE_KEY, {}));
      return state;
    },
    updateQueuedFollowUps(update) {
      const work = pending.then(async () => {
        if (!navigator.locks?.request) throw new Error('Harness queue requires Web Locks');
        await navigator.locks.request('harnessmix-native-queued-follow-ups-v1', async () => {
          const latest = asState(nativeStorage.TB(STORAGE_KEY, {}));
          const next = asState(update(latest));
          if (next === latest) { state = latest; return; }
          await Promise.resolve(nativeStorage.jx(STORAGE_KEY, next));
          state = next;
        });
        for (const listener of listeners) listener();
      });
      pending = work.catch(() => undefined);
      return work;
    },
    subscribeQueuedFollowUps(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createNativeQueueCoordination(ownsThread: (id: string) => boolean): {
  queuedMessageCoordination: object;
  queuedSendLocks: object;
  dispose(): void;
} {
  const channel = new BroadcastChannel('harnessmix-native-queue-v1');
  const clientId = crypto.randomUUID();
  const listeners = new Set<(event: any) => void>();
  const releases = new Map<string, (sent: boolean) => void>();
  channel.addEventListener('message', (event) => {
    const frame = event.data;
    const conversationId = frame?.params?.conversationId;
    if (frame?.sourceClientId !== clientId && typeof conversationId === 'string' && ownsThread(conversationId)) {
      for (const listener of listeners) listener(frame);
    }
  });
  return {
    queuedMessageCoordination: {
      broadcast(params: any) {
        if (!ownsThread(params?.conversationId)) throw new Error('Unknown thread cannot enter Harness queue coordination');
        channel.postMessage({ params: { ...params, hostId: 'local' }, sourceClientId: clientId });
        return Promise.resolve();
      },
      registerBroadcastHandler(listener: (event: any) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    queuedSendLocks: {
      async acquire({ conversationId, lockId }: { conversationId: string; lockId: string }) {
        if (!ownsThread(conversationId)) throw new Error('Unknown thread cannot acquire a Harness queue lock');
        if (!navigator.locks?.request) throw new Error('Harness queue requires Web Locks');
        let report!: (acquired: boolean) => void;
        const acquired = new Promise<boolean>((resolve) => { report = resolve; });
        void navigator.locks.request(
          `harnessmix-native-send:${conversationId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) { report(false); return; }
            let release!: (sent: boolean) => void;
            const held = new Promise<boolean>((resolve) => { release = resolve; });
            releases.set(lockId, release);
            report(true);
            await held;
            releases.delete(lockId);
          },
        );
        return { acquired: await acquired };
      },
      async release({ lockId, sent }: { lockId: string; sent: boolean }) {
        releases.get(lockId)?.(sent);
      },
    },
    dispose() {
      for (const release of releases.values()) release(false);
      releases.clear();
      listeners.clear();
      channel.close();
    },
  };
}

export async function migrateExternalQueuedMessages(options: {
  webpackRequire: NativeWebpackRequire;
  scope: NativeRendererScope;
  storage: NativeQueuedMessageStorage;
  ownsThread(threadId: string): boolean;
}): Promise<string[]> {
  const { webpackRequire, scope, storage, ownsThread } = options;
  const queueModule = webpackRequire('wkUO');
  if (!queueModule.Zj || typeof queueModule.CN !== 'function') {
    throw new Error('Desktop stock queue transaction is unavailable');
  }
  const stockState = asState(scope.get(queueModule.Zj)?.data?.state);
  const migrating = Object.fromEntries(
    Object.entries(stockState)
      .filter(([id]) => ownsThread(id))
      .map(([id, value]) => [id, structuredClone(value)]),
  );
  const ids = Object.keys(migrating);
  if (ids.length === 0) return ids;
  const inserted = new Set<string>();
  await storage.updateQueuedFollowUps((current) => {
    const next = { ...current };
    for (const id of ids) {
      if (current[id] === undefined) {
        next[id] = migrating[id];
        inserted.add(id);
      } else if (JSON.stringify(current[id]) !== JSON.stringify(migrating[id])) {
        throw new Error('External queue already contains conflicting durable state');
      }
    }
    return next;
  });
  const rollbackInserted = () => storage.updateQueuedFollowUps((current) => {
    const next = { ...current };
    for (const id of inserted) {
      if (JSON.stringify(current[id]) === JSON.stringify(migrating[id])) delete next[id];
    }
    return next;
  });
  let conflicted = false;
  try {
    await queueModule.CN(scope, (value: unknown) => {
      const current = asState(value);
      if (ids.some((id) => JSON.stringify(current[id]) !== JSON.stringify(migrating[id]))) {
        conflicted = true;
        return current;
      }
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
  } catch (error) {
    await rollbackInserted();
    throw error;
  }
  if (conflicted) {
    await rollbackInserted();
    throw new Error('External queue changed during guarded migration');
  }
  return ids;
}
