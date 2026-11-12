type NativeManager = Record<string, any>;
type Response = Record<string, any>;

/**
 * Desktop's command/file approvals await delivery, but these three native
 * handlers mutate their request state synchronously. Stage their own response
 * transformation, await Host acknowledgement, then let the same native handler
 * apply the result. No temporary override survives an await.
 */
export function installNativeApprovalAcknowledgementGate(
  manager: NativeManager,
  respond: (method: string, response: Response) => Promise<void>,
): () => void {
  const methods = ['replyWithUserInputResponse', 'replyWithPermissionsRequestApprovalResponse', 'replyWithOptionPickerResponse'];
  const restorations: Array<() => void> = [];
  const active = new Map<string, { signature: string; work: Promise<unknown> }>();
  let disposed = false;
  for (const name of methods) {
    const original = manager[name];
    if (typeof original !== 'function') continue;
    const gated = (...args: any[]): Promise<unknown> => {
      if (disposed) return Promise.reject(new Error('Harness approval connection is disposed'));
      const key = `${name}:${String(args[0])}:${String(args[1])}`;
      const signature = JSON.stringify(args[2]);
      const previous = active.get(key);
      if (previous) return previous.signature === signature ? previous.work : Promise.reject(new Error('A different answer is already awaiting acknowledgement'));
      const work = (async () => {
        if (manager.getStreamRole?.(args[0])?.role === 'follower') throw new Error('Harness approval belongs to another active controller');
        const marker = {};
        let staged: { method: string; response: Response } | undefined;
        const dispatch = manager.sendAppServerResponse;
        let returned: unknown;
        manager.sendAppServerResponse = (method: string, response: Response) => {
          staged = { method, response };
          throw marker;
        };
        try { returned = Reflect.apply(original, manager, args); }
        catch (error) { if (error !== marker) throw error; }
        finally { manager.sendAppServerResponse = dispatch; }
        if (!staged) return returned;
        await respond(staged.method, staged.response);
        if (disposed) return undefined;
        const acknowledged = staged;
        const currentDispatch = manager.sendAppServerResponse;
        manager.sendAppServerResponse = (method: string, response: Response, ...rest: unknown[]) => {
          if (method === acknowledged.method && response.id === acknowledged.response.id) return undefined;
          return Reflect.apply(currentDispatch, manager, [method, response, ...rest]);
        };
        try { return Reflect.apply(original, manager, args); }
        finally { manager.sendAppServerResponse = currentDispatch; }
      })();
      active.set(key, { signature, work });
      void work.finally(() => { if (active.get(key)?.work === work) active.delete(key); }).catch(() => undefined);
      return work;
    };
    manager[name] = gated;
    restorations.push(() => { if (manager[name] === gated) manager[name] = original; });
  }
  return () => { disposed = true; for (const restore of restorations.reverse()) restore(); active.clear(); };
}
