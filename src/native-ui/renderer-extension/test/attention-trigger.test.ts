import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installAttentionTrigger } from '../src/attention-trigger.js';

type Listener = () => void;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly style = { display: '' };
  parentElement: FakeElement | null = null;
  className = '';
  textContent = '';
  title = '';
  hidden = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly tagName: string) {}
  get isConnected(): boolean { return this === fakeDocument.documentElement || !!this.parentElement?.isConnected; }
  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null;
  }
  get nextSibling(): FakeElement | null { return this.nextElementSibling; }
  setAttribute(name: string, value: string): void {
    if (this.attributes.get(name) === value) return;
    this.attributes.set(name, value);
    notify(this, 'attributes', name);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void {
    if (!this.attributes.delete(name)) return;
    notify(this, 'attributes', name);
  }
  closest(selector: string): FakeElement | null {
    if (selector !== '[hidden]') return null;
    for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.hidden) return node;
    return null;
  }
  checkVisibility(): boolean {
    for (let node: FakeElement | null = this; node; node = node.parentElement) {
      if (node.hidden || node.style.display === 'none') return false;
    }
    return this.isConnected;
  }
  getClientRects(): Array<{ width: number; height: number }> { return this.checkVisibility() ? [{ width: 36, height: 36 }] : []; }
  append(...nodes: FakeElement[]): void { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
    if (node.parentElement) {
      const oldParent = node.parentElement;
      oldParent.children.splice(oldParent.children.indexOf(node), 1);
      notify(oldParent, 'childList');
    }
    node.parentElement = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    notify(this, 'childList');
    return node;
  }
  remove(): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
    notify(parent, 'childList');
  }
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  click(): void { for (const listener of this.listeners.get('click') ?? []) listener(); }
}

class FakeDocument {
  readonly documentElement = new FakeElement('HTML');
  readonly head = new FakeElement('HEAD');
  readonly body = new FakeElement('BODY');
  constructor() { this.documentElement.append(this.head, this.body); }
  createElement(tag: string): FakeElement { return new FakeElement(tag.toUpperCase()); }
  querySelectorAll(selector: string): FakeElement[] {
    const destination = selector.match(/^button\[data-sidebar-destination="([^"]+)"\]$/)?.[1];
    if (!destination) return [];
    const result: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      if (node.tagName === 'BUTTON' && node.getAttribute('data-sidebar-destination') === destination) result.push(node);
      node.children.forEach(visit);
    };
    visit(this.documentElement);
    return result;
  }
}

class FakeMutationObserver {
  static readonly all: FakeMutationObserver[] = [];
  target: FakeElement | null = null;
  options: MutationObserverInit = {};
  disconnected = false;
  calls = 0;
  constructor(readonly callback: MutationCallback) { FakeMutationObserver.all.push(this); }
  observe(target: Node, options: MutationObserverInit): void {
    this.target = target as unknown as FakeElement;
    this.options = options;
  }
  disconnect(): void { this.disconnected = true; }
}

let fakeDocument: FakeDocument;

function contains(root: FakeElement, target: FakeElement): boolean {
  for (let node: FakeElement | null = target; node; node = node.parentElement) if (node === root) return true;
  return false;
}

function notify(target: FakeElement, type: MutationRecordType, attributeName?: string): void {
  for (const observer of FakeMutationObserver.all) {
    if (observer.disconnected || !observer.target) continue;
    const inScope = target === observer.target || (!!observer.options.subtree && contains(observer.target, target));
    if (!inScope || (type === 'childList' && !observer.options.childList) || (type === 'attributes' && !observer.options.attributes)) continue;
    if (attributeName && observer.options.attributeFilter && !observer.options.attributeFilter.includes(attributeName)) continue;
    observer.calls += 1;
    observer.callback([{ target, type, attributeName } as unknown as MutationRecord], observer as unknown as MutationObserver);
  }
}

function button(destination?: string): HTMLButtonElement {
  const element = fakeDocument.createElement('button');
  if (destination) element.setAttribute('data-sidebar-destination', destination);
  return element as unknown as HTMLButtonElement;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('attention trigger mount', () => {
  beforeEach(() => {
    FakeMutationObserver.all.length = 0;
    fakeDocument = new FakeDocument();
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts below Sites in the same native rail and copies its presentation', async () => {
    const rail = fakeDocument.createElement('div');
    const review = button('builtin:pull-requests') as unknown as FakeElement;
    const sites = button('builtin:sites') as unknown as FakeElement;
    sites.className = 'native-button';
    sites.setAttribute('data-color', 'secondary');
    sites.setAttribute('data-variant', 'ghost');
    rail.append(review, sites);
    fakeDocument.body.append(rail);
    const trigger = button() as unknown as FakeElement;
    trigger.setAttribute('style', 'margin-right:6px;border:1px solid transparent');

    installAttentionTrigger(trigger as unknown as HTMLButtonElement);
    await settle();

    expect(rail.children).toEqual([review, sites, trigger]);
    expect(trigger.className).toBe('native-button');
    expect(trigger.getAttribute('data-variant')).toBe('ghost');
    expect(trigger.getAttribute('style')).toBeNull();
    expect(fakeDocument.head.children[0]?.textContent).toContain('width:36px');
    expect(fakeDocument.head.children[0]?.textContent).toContain('::after');
    expect(fakeDocument.head.children[0]?.textContent).toContain('all:initial');
  });

  it('moves out of a retained hidden header and falls back to Review when Sites is absent', async () => {
    const hiddenHeader = fakeDocument.createElement('div'); hiddenHeader.style.display = 'none';
    const rail = fakeDocument.createElement('div');
    const review = button('builtin:pull-requests') as unknown as FakeElement;
    const trigger = button() as unknown as FakeElement;
    hiddenHeader.append(trigger); rail.append(review); fakeDocument.body.append(hiddenHeader, rail);

    installAttentionTrigger(trigger as unknown as HTMLButtonElement);
    await settle();

    expect(rail.children).toEqual([review, trigger]);
    expect(hiddenHeader.children).toHaveLength(0);
  });

  it('keeps the same button and click handler across a full sidebar remount', async () => {
    const firstRail = fakeDocument.createElement('div');
    const firstSites = button('builtin:sites') as unknown as FakeElement;
    firstRail.append(firstSites); fakeDocument.body.append(firstRail);
    const trigger = button() as unknown as FakeElement;
    const opened = vi.fn(); trigger.addEventListener('click', opened);
    installAttentionTrigger(trigger as unknown as HTMLButtonElement);
    await settle();

    firstRail.remove();
    const secondRail = fakeDocument.createElement('div');
    const secondSites = button('builtin:sites') as unknown as FakeElement;
    secondRail.append(secondSites); fakeDocument.body.append(secondRail);
    await settle();
    trigger.click();

    expect(secondRail.children).toEqual([secondSites, trigger]);
    expect(opened).toHaveBeenCalledOnce();
  });

  it('waits for a delayed anchor and does not spin mutation updates', async () => {
    const trigger = button() as unknown as FakeElement;
    installAttentionTrigger(trigger as unknown as HTMLButtonElement);
    await settle();
    expect(trigger.parentElement).toBeNull();

    const rail = fakeDocument.createElement('div');
    const sites = button('builtin:sites') as unknown as FakeElement;
    rail.append(sites); fakeDocument.body.append(rail);
    await settle();
    const callsAfterMount = FakeMutationObserver.all.reduce((sum, observer) => sum + observer.calls, 0);
    await settle();

    expect(trigger.parentElement).toBe(rail);
    expect(FakeMutationObserver.all.reduce((sum, observer) => sum + observer.calls, 0)).toBe(callsAfterMount);
    expect(callsAfterMount).toBeLessThan(20);
  });

  it('uses an explicit container, mirrors the accessible label to title, and disposes cleanly', async () => {
    const container = fakeDocument.createElement('div'); fakeDocument.body.append(container);
    const trigger = button() as unknown as FakeElement;
    trigger.setAttribute('aria-label', '打开对话工作台，2 条新动态');
    const control = installAttentionTrigger(trigger as unknown as HTMLButtonElement, { container: container as unknown as HTMLElement });
    await settle();

    expect(trigger.parentElement).toBe(container);
    expect(trigger.title).toBe('打开对话工作台，2 条新动态');
    trigger.setAttribute('aria-label', '返回对话工作台');
    expect(trigger.title).toBe('返回对话工作台');
    control.dispose();

    expect(trigger.parentElement).toBeNull();
    expect(fakeDocument.head.children).toHaveLength(0);
    expect(FakeMutationObserver.all.every(observer => observer.disconnected)).toBe(true);
  });
});
