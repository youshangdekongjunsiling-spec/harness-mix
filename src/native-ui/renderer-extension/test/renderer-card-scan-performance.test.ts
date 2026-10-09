import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/collaboration-icon.js", () => ({
  collaborationIcon: () => document.createElement("span"),
}));
vi.mock("../src/renderer-fork-control.js", () => ({ openRendererThread: vi.fn() }));

import { installCollabCards } from "../src/renderer-collab-cards.js";
import { installTeamCards } from "../src/renderer-team-cards.js";

class FakeClassList {
  private readonly values = new Set<string>();
  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
  set(value: string) { this.values.clear(); value.split(/\s+/).filter(Boolean).forEach((name) => this.values.add(name)); }
}

class FakeElement {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = { cssText: "", display: "" };
  readonly classList = new FakeClassList();
  parentElement: FakeElement | null = null;
  isConnected = true;
  private ownText = "";
  private attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}
  set className(value: string) { this.classList.set(value); }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = value; }
  set innerHTML(value: string) { this.ownText = value; }
  get innerHTML() { return this.ownText; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const rule = part.trim();
      if (rule.startsWith(".")) return this.classList.contains(rule.slice(1));
      if (rule === "pre") return this.tagName === "PRE";
      if (rule === "[data-turn-key]") return this.attributes.has("data-turn-key");
      if (rule === "[data-local-conversation-item-target-ids]") return this.attributes.has("data-local-conversation-item-target-ids");
      if (rule === "[data-testid*=\"tool\"]") return this.attributes.get("data-testid")?.includes("tool") ?? false;
      if (rule === "pre[data-testid*=\"tool\"]") return this.tagName === "PRE" && (this.attributes.get("data-testid")?.includes("tool") ?? false);
      return false;
    });
  }
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeElement) => node.children.forEach((child) => {
      if (child.matches(selector)) found.push(child);
      visit(child);
    });
    visit(this);
    return found;
  }
  querySelector(selector: string): FakeElement | null {
    if (selector.startsWith(":scope > .")) return this.children.find((child) => child.classList.contains(selector.slice(10))) ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
  append(...nodes: FakeElement[]) { nodes.forEach((node) => { node.parentElement = this; node.isConnected = this.isConnected; this.children.push(node); }); }
  after(node: FakeElement) {
    if (!this.parentElement) return;
    node.parentElement = this.parentElement;
    node.isConnected = this.isConnected;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
    this.isConnected = false;
  }
  replaceChildren(...nodes: FakeElement[]) { this.children.splice(0); this.append(...nodes); }
  addEventListener() {}
  focus() {}
}

class FakeMutationObserver {
  static latest: FakeMutationObserver;
  disconnected = false;
  constructor(readonly callback: MutationCallback) { FakeMutationObserver.latest = this; }
  observe() {}
  disconnect() { this.disconnected = true; }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function installFakeDom() {
  const body = new FakeElement("BODY");
  const head = new FakeElement("HEAD");
  const documentElement = new FakeElement("HTML");
  documentElement.append(head, body);
  const querySelectorAll = vi.fn((selector: string) => body.querySelectorAll(selector));
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("document", {
    body, head, documentElement,
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    querySelectorAll,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  return { body, querySelectorAll };
}

describe("renderer card incremental scans", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([
    ["collab", () => installCollabCards()],
    ["team", () => installTeamCards()],
  ])("keeps unrelated mutations local and disconnects the %s observer", async (_name, install) => {
    const { body, querySelectorAll } = installFakeDom();
    const control = install();
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    const ordinary = new FakeElement("DIV");
    body.append(ordinary);
    FakeMutationObserver.latest.callback([{ target: ordinary, addedNodes: [] } as unknown as MutationRecord], FakeMutationObserver.latest as unknown as MutationObserver);
    await flush();
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    control.dispose();
    expect(FakeMutationObserver.latest.disconnected).toBe(true);
  });

  it("enhances a collaboration payload when streamed text becomes complete", async () => {
    const { body, querySelectorAll } = installFakeDom();
    const control = installCollabCards();
    const card = new FakeElement("PRE");
    card.setAttribute("data-testid", "tool-result");
    card.textContent = '{"task_id":"task-1","child_thread_id":';
    body.append(card);
    FakeMutationObserver.latest.callback([{ target: body, addedNodes: [card] } as unknown as MutationRecord], FakeMutationObserver.latest as unknown as MutationObserver);
    await flush();
    expect(card.querySelector(":scope > .harness-mix-collab-actions")).toBeNull();
    card.textContent = '{"task_id":"task-1","child_thread_id":"thread-1"}';
    const text = { nodeType: 3, parentElement: card };
    FakeMutationObserver.latest.callback([{ target: text, addedNodes: [] } as unknown as MutationRecord], FakeMutationObserver.latest as unknown as MutationObserver);
    await flush();
    expect(card.querySelector(":scope > .harness-mix-collab-actions")).not.toBeNull();
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    control.dispose();
  });

  it("keeps the team panel on the deepest known payload after a sibling mutation", async () => {
    const { body, querySelectorAll } = installFakeDom();
    const outer = new FakeElement("DIV");
    outer.setAttribute("data-turn-key", "outer");
    const inner = new FakeElement("PRE");
    inner.setAttribute("data-testid", "tool-result");
    inner.textContent = JSON.stringify({ team_id: "team-1", name: "Team", goal: "Goal", status: "active", members: [], tasks: [], messages: [] });
    const sibling = new FakeElement("SPAN");
    outer.append(inner, sibling);
    body.append(outer);
    const control = installTeamCards();
    expect(inner.nextElementSibling?.classList.contains("harness-mix-team-panel")).toBe(true);
    expect(outer.querySelectorAll(".harness-mix-team-panel")).toHaveLength(1);
    FakeMutationObserver.latest.callback([{ target: sibling, addedNodes: [] } as unknown as MutationRecord], FakeMutationObserver.latest as unknown as MutationObserver);
    await flush();
    expect(inner.nextElementSibling?.classList.contains("harness-mix-team-panel")).toBe(true);
    expect(outer.querySelectorAll(".harness-mix-team-panel")).toHaveLength(1);
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    control.dispose();
  });
});
