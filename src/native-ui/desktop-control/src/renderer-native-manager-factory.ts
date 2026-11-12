import { createHash } from 'node:crypto';

interface RendererEvaluator { evaluate<T>(expression: string): Promise<T> }
const EXPECTED_SHA256 = '36d8a030eb70b1e49680a36261bce50e93b1d72a6175b9a9abb44d4cb869c3d9';
const FACTORY_START = 'function(e,t,n,i,s,{dispatchMessageFromView:o=';
const FACTORY_END = '}(e,t,e.get(o.n,t),e4.Q.bind(null,e),(e,t)=>e(d.RO,t))';
const OPTIONS_MARKER = 'supportsPaginatedThreadHistory:D}={}){';
const QUEUE_START = 'readQueuedFollowUps(){let t=null==e?null:e.get(eA.Zj);';
const QUEUE_END = 'updateQueuedFollowUps:t=>null==e?Promise.reject(Error("Queued message updates require an app scope")):(0,eA.CN)(e,t)}';

function addIsolatedQueueOption(factory: string): string {
  if (factory.split(OPTIONS_MARKER).length !== 2) {
    throw new Error('Desktop native manager option marker is incompatible');
  }
  const start = factory.indexOf(QUEUE_START);
  const end = factory.indexOf(QUEUE_END, start);
  if (start < 0 || end < 0 || factory.indexOf(QUEUE_START, start + 1) >= 0 ||
      factory.indexOf(QUEUE_END, end + 1) >= 0) {
    throw new Error('Desktop native queued storage markers are incompatible');
  }
  const original = factory.slice(start, end + QUEUE_END.length);
  return factory
    .replace(OPTIONS_MARKER, 'supportsPaginatedThreadHistory:D,queuedMessageStorage:harnessQueue}={}){')
    .replace(original, `...(harnessQueue??{${original.slice(0, -1)}})}`);
}

function copiedModuleSource(source: string): string {
  if (createHash('sha256').update(source).digest('hex') !== EXPECTED_SHA256) {
    throw new Error('Desktop native manager factory source is not the reviewed 26.1106 build');
  }
  const callable = source.startsWith('cfCu(') ? `function${source.slice(4)}` : source;
  const start = callable.indexOf(FACTORY_START);
  const end = callable.indexOf(FACTORY_END, start);
  if (start < 0 || end < 0 || callable.indexOf(FACTORY_START, start + 1) >= 0 ||
      callable.indexOf(FACTORY_END, end + 1) >= 0) {
    throw new Error('Desktop native manager factory markers are incompatible');
  }
  const factory = addIsolatedQueueOption(callable.slice(start, end + 1));
  return `${callable.slice(0, -1)};t.__harnessmixNativeManagerFactoryV1=${factory};}`;
}

/** Two CDP evaluations avoid page-level eval/Function and leave CSP unchanged. */
export async function installRendererNativeManagerFactory(renderer: RendererEvaluator): Promise<void> {
  const source = await renderer.evaluate<string>(`(async () => {
    if (typeof window.__harnessmixNativeManagerFactoryV1 === 'function' && window.__harnessmixNativeManagerFactoryQueueV1 === true) return 'ready';
    const asset = await import('app://-/assets/348410.1a97dde15f.js');
    Object.defineProperty(window, '__harnessmixNativeRequireV1', { configurable: true, value: asset.__webpack_require__ });
    return Function.prototype.toString.call(asset.__webpack_require__.m.cfCu);
  })()`);
  if (source === 'ready') return;
  if (typeof source !== 'string') throw new Error('Desktop cfCu module source is unavailable');
  const copied = copiedModuleSource(source);
  const result = await renderer.evaluate<unknown>(`(() => {
    const webpackRequire = window.__harnessmixNativeRequireV1;
    const copiedModule = (${copied});
    const exports = {};
    copiedModule({ exports }, exports, webpackRequire);
    if (typeof exports.__harnessmixNativeManagerFactoryV1 !== 'function') throw new Error('Desktop native manager factory export failed');
    Object.defineProperty(window, '__harnessmixNativeManagerFactoryV1', { configurable: true, value: exports.__harnessmixNativeManagerFactoryV1 });
    Object.defineProperty(window, '__harnessmixNativeManagerFactoryQueueV1', { configurable: true, value: true });
    return { state: 'ready' };
  })()`);
  if (!result || typeof result !== 'object' || (result as { state?: unknown }).state !== 'ready') {
    throw new Error('Desktop native manager factory installer returned an invalid status');
  }
}
