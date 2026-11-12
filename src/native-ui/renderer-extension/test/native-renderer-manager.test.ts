import { describe, expect, it, vi } from 'vitest';
import { createNativeCompositeRpc, rpcThreadId } from '../src/native-composite-rpc.js';
import { findNativeRpcHookValues } from '../src/install-native-renderer-manager.js';
import {
  createNativeTurnCoordinatorTarget,
  nativeManagerFactoryExpression,
} from '../src/native-renderer-manager.js';

describe('native renderer manager compatibility', () => {
  it('wraps the coordinator target in a native RpcStub', async () => {
    class RpcTarget {}
    let wrapped: any;
    class RpcStub { constructor(target: any) { wrapped = target; return target; } }
    const routed = { sendMessage: vi.fn(async () => 'sent') };
    const target = createNativeTurnCoordinatorTarget(
      ((id: string) => id === 'ZG9f' ? { TF: RpcTarget, AX: RpcStub } : {}) as any,
      routed,
    );
    expect(target).toBeInstanceOf(RpcTarget);
    expect(target).toBe(wrapped);
    await expect(target.sendMessage('external-1', { id: 'message' })).resolves.toBe('sent');
    expect(routed.sendMessage).toHaveBeenCalledWith('external-1', { id: 'message' });
  });

  it('extracts one exact inner native factory and rejects drift', () => {
    const factory = 'function(e,t,n,i,s,{dispatchMessageFromView:o=()=>{}}={}){return 1}';
    const source = `function(e,t,n){let w;w=${factory}(e,t,e.get(o.n,t),e4.Q.bind(null,e),(e,t)=>e(d.RO,t))}`;
    expect(nativeManagerFactoryExpression(source)).toBe(factory);
    expect(() => nativeManagerFactoryExpression(source.replace('e4.Q', 'e4.X'))).toThrow(/terminator/);
  });

  it('finds only the native local {hostId,rpc} hook contract', () => {
    const host = {} as Element;
    const rpc = { subscribe: vi.fn() };
    const native = { hostId: 'local', rpc };
    Object.defineProperty(host, '__reactFiber$fixture', {
      value: { memoizedState: { memoizedState: native, next: { memoizedState: { hostId: 'remote', rpc } } } },
    });
    const root = { querySelectorAll: () => [host] } as unknown as ParentNode;
    expect(findNativeRpcHookValues(root)).toEqual([native]);
  });

  it('routes only proven external thread calls and leaves unknown calls official', () => {
    const official = { read: vi.fn(() => 'official') };
    const external = { read: vi.fn(() => 'external') };
    const rpc = createNativeCompositeRpc(official, external, new Set(['external-thread']));
    expect(rpc.read({ threadId: 'external-thread' })).toBe('external');
    expect(rpc.read({ threadId: 'official-thread' })).toBe('official');
    expect(rpc.read({ threadId: 'unknown-thread' })).toBe('official');
    expect(external.read).toHaveBeenCalledOnce();
  });

  it('extracts thread identity only from reviewed fields', () => {
    expect(rpcThreadId([{ key: { conversationId: 'thread-a' } }])).toBe('thread-a');
    expect(rpcThreadId([{ id: 'not-a-thread' }])).toBeNull();
  });

  it('merges host thread-id subscriptions while preserving both disposables', () => {
    const dispose: symbol = (Symbol as any).dispose ?? Symbol.for('Symbol.dispose');
    const leftDispose = vi.fn();
    const rightDispose = vi.fn();
    let leftListener!: (value: unknown) => void;
    let rightListener!: (value: unknown) => void;
    const official = { subscribe: vi.fn((value) => { leftListener = value.listener; return { [dispose]: leftDispose }; }) };
    const external = { subscribe: vi.fn((value) => { rightListener = value.listener; return { [dispose]: rightDispose }; }) };
    const listener = vi.fn();
    const rpc = createNativeCompositeRpc(official, external, new Set());
    const subscription = rpc.subscribe({ type: 'host', key: { hostId: 'local' }, field: 'threadSummaryIds', listener });
    leftListener({ all: ['official'], topLevel: ['official'] });
    rightListener({ all: ['external'], topLevel: ['external'] });
    expect(listener).toHaveBeenLastCalledWith({ all: ['official', 'external'], topLevel: ['official', 'external'] });
    subscription[dispose]();
    expect(leftDispose).toHaveBeenCalledOnce();
    expect(rightDispose).toHaveBeenCalledOnce();
  });
});
