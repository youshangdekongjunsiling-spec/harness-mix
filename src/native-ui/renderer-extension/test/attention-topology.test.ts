import { describe, expect, it } from 'vitest';
import { buildAttentionTopology, compactAttentionTopology } from '../src/attention-topology.js';
import type { AttentionRepository, AttentionThread } from '../src/attention-types.js';

const repository = (overrides: Partial<AttentionRepository> = {}): AttentionRepository => ({
  id: 'repo', root: '/repo', paths: ['/repo', '/feature'], available: true, defaultBranch: 'main',
  commits: [], branches: [], worktrees: [], truncated: false, ...overrides,
});
const thread = (id: string, overrides: Partial<AttentionThread> = {}): AttentionThread => ({
  id, title: id, harnessId: 'codex', cwd: '/repo', projectId: null, updatedAt: 1,
  status: 'idle', source: 'native', ...overrides,
});

function expectClearParentTracks(graph: ReturnType<typeof buildAttentionTopology>): void {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  for (const edge of graph.edges) {
    if (!edge.to) continue;
    const child = nodes.get(edge.from)!;
    const parent = nodes.get(edge.to)!;
    expect(parent.row).toBeGreaterThan(child.row);
    expect(graph.nodes.some(node => node.row > child.row && node.row < parent.row && node.track === parent.track),
      `${edge.from} -> ${edge.to} must keep parent track ${parent.track} clear`).toBe(false);
  }
}

describe('attention topology', () => {
  it('draws a real fork and merge with ancestry before timestamps', () => {
    const repo = repository({
      commits: [
        { hash: 'base', parents: [], subject: 'base', timestamp: 999 },
        { hash: 'left', parents: ['base'], subject: 'left', timestamp: 2 },
        { hash: 'right', parents: ['base'], subject: 'right', timestamp: 3 },
        { hash: 'merge', parents: ['left', 'right'], subject: 'merge', timestamp: 1 },
      ],
      branches: [{ name: 'main', head: 'merge', merged: false }, { name: 'feature', head: 'right', merged: true }],
      worktrees: [{ path: '/repo', branch: 'main', head: 'merge', dirty: 0, detached: false }],
    });
    const graph = buildAttentionTopology(repo, []);
    const row = (hash: string) => graph.nodes.find(node => node.hash === hash)!.row;
    expect(row('merge')).toBeLessThan(row('left'));
    expect(row('merge')).toBeLessThan(row('right'));
    expect(row('left')).toBeLessThan(row('base'));
    expect(row('right')).toBeLessThan(row('base'));
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: 'merge', to: 'left', parentIndex: 0 }, { from: 'merge', to: 'right', parentIndex: 1 },
      { from: 'left', to: 'base', parentIndex: 0 }, { from: 'right', to: 'base', parentIndex: 0 },
    ]));
    expect(graph.nodes.filter(node => node.hash === 'base')).toHaveLength(1);
    expect(graph.trackCount).toBeGreaterThan(1);
    expectClearParentTracks(graph);
  });

  it('stacks refs and worktrees sharing one HEAD on one node', () => {
    const repo = repository({
      commits: [{ hash: 'head', parents: [], subject: 'head', timestamp: 1 }],
      branches: [{ name: 'release', head: 'head', merged: false }, { name: 'main', head: 'head', merged: false }],
      worktrees: [
        { path: '/repo', branch: 'main', head: 'head', dirty: 0, detached: false },
        { path: '/feature', branch: 'release', head: 'head', dirty: 2, detached: false },
      ],
    });
    const graph = buildAttentionTopology(repo, []);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ id: 'head', branches: ['main', 'release'] });
    expect(graph.nodes[0]?.worktrees.map(worktree => worktree.path)).toEqual(['/feature', '/repo']);
  });

  it('marks missing parents as boundaries without inventing nodes', () => {
    const graph = buildAttentionTopology(repository({
      commits: [{ hash: 'visible', parents: ['outside'], subject: 'visible', timestamp: 1 }], truncated: true,
    }), []);
    expect(graph.nodes.map(node => node.hash)).toEqual(['visible']);
    expect(graph.edges).toEqual([{ from: 'visible', to: null, parentIndex: 0, boundary: { hash: 'outside' } }]);
    expect(graph.missingParents).toEqual([{ from: 'visible', hash: 'outside' }]);
    expect(graph.truncated).toBe(true);
  });

  it('anchors conversations only to exact existing commits', () => {
    const repo = repository({
      commits: [{ hash: 'old', parents: [], subject: 'old', timestamp: 1 }, { hash: 'head', parents: ['old'], subject: 'head', timestamp: 2 }],
      branches: [{ name: 'main', head: 'head', merged: false }],
      worktrees: [{ path: '/repo', branch: 'main', head: 'head', dirty: 3, detached: false }],
    });
    const graph = buildAttentionTopology(repo, [
      thread('workspace', { status: 'running', activity: { cwd: '/repo', observedAt: 2, source: 'command' } }),
      thread('recorded', { gitInfo: { branch: 'main', sha: 'old' } }),
      thread('missing', { gitInfo: { branch: 'gone', sha: 'not-loaded' } }),
      thread('no-hash', { gitInfo: { branch: 'gone' } }),
      thread('unbound', { cwd: '/elsewhere' }),
    ]);
    expect(graph.pins).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: 'workspace', nodeId: 'head', kind: 'workspace', dirty: 3 }),
      expect.objectContaining({ threadId: 'recorded', nodeId: 'old', kind: 'commit', dirty: null }),
    ]));
    expect(graph.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: 'missing', reason: 'missing-commit', hash: 'not-loaded' }),
      expect.objectContaining({ threadId: 'no-hash', reason: 'no-hash' }),
      expect.objectContaining({ threadId: 'unbound', reason: 'unbound' }),
    ]));
  });

  it('supports octopus merges, multiple roots, full pages, and stable output', () => {
    const repo = repository({
      commits: [
        { hash: 'a', parents: [], subject: 'a', timestamp: 1 },
        { hash: 'b', parents: [], subject: 'b', timestamp: 1 },
        { hash: 'c', parents: [], subject: 'c', timestamp: 1 },
        { hash: 'octopus', parents: ['a', 'b', 'c'], subject: 'octopus', timestamp: 0 },
        ...Array.from({ length: 9 }, (_, index) => ({ hash: `root-${index}`, parents: [] as string[], subject: `${index}`, timestamp: index })),
      ],
      branches: [{ name: 'main', head: 'octopus', merged: false }],
    });
    const first = buildAttentionTopology(repo, [], 10);
    const second = buildAttentionTopology({ ...repo, commits: [...repo.commits].reverse() }, [], 10);
    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(13);
    expect(first.pageCount).toBe(2);
    expect(first.nodes.filter(node => node.page === 1)).toHaveLength(3);
    expect(first.edges.filter(edge => edge.from === 'octopus')).toHaveLength(3);
  });

  it('handles a 1024-commit snapshot without clipping the model', () => {
    const commits = Array.from({ length: 1024 }, (_, index) => ({
      hash: `c${index}`, parents: index ? [`c${index - 1}`] : [], subject: `${index}`, timestamp: index,
    }));
    const graph = buildAttentionTopology(repository({ commits, branches: [{ name: 'main', head: 'c1023', merged: false }] }), []);
    expect(graph.nodes).toHaveLength(1024);
    expect(graph.pageCount).toBe(103);
    expect(graph.nodes[0]?.hash).toBe('c1023');
    expect(graph.nodes.at(-1)?.hash).toBe('c0');
  });

  it('compacts only linear unannotated chains and records every skipped commit', () => {
    const repo = repository({
      commits: [
        { hash: 'root', parents: [], subject: 'root', timestamp: 1 },
        { hash: 'middle-1', parents: ['root'], subject: 'middle 1', timestamp: 2 },
        { hash: 'middle-2', parents: ['middle-1'], subject: 'middle 2', timestamp: 3 },
        { hash: 'fork', parents: ['middle-2'], subject: 'fork', timestamp: 4 },
        { hash: 'left', parents: ['fork'], subject: 'left', timestamp: 5 },
        { hash: 'right', parents: ['fork'], subject: 'right', timestamp: 6 },
        { hash: 'merge', parents: ['left', 'right'], subject: 'merge', timestamp: 7 },
      ],
      branches: [
        { name: 'main', head: 'merge', merged: false },
        { name: 'left-ref', head: 'left', merged: true },
        { name: 'right-ref', head: 'right', merged: true },
      ],
      worktrees: [{ path: '/repo', branch: 'main', head: 'merge', dirty: 0, detached: false }],
    });
    const compact = compactAttentionTopology(buildAttentionTopology(repo, [
      thread('at-fork', { gitInfo: { branch: 'old', sha: 'fork' } }),
    ]));
    expect(compact.nodes.map(node => node.hash)).toEqual(expect.arrayContaining(['root', 'fork', 'left', 'right', 'merge']));
    expect(compact.nodes.map(node => node.hash)).not.toEqual(expect.arrayContaining(['middle-1', 'middle-2']));
    expect(compact.edges).toContainEqual({
      from: 'fork', to: 'root', parentIndex: 0, via: ['middle-2', 'middle-1'], skippedCount: 2,
    });
    expect(compact.pins).toContainEqual(expect.objectContaining({ threadId: 'at-fork', nodeId: 'fork' }));
    expect(compact.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'merge', to: 'left' }),
      expect.objectContaining({ from: 'merge', to: 'right' }),
      expect.objectContaining({ from: 'left', to: 'fork' }),
      expect.objectContaining({ from: 'right', to: 'fork' }),
    ]));
    expectClearParentTracks(compact);
  });

  it('keeps reserved parent tracks clear across merges and multiple roots', () => {
    const repo = repository({
      commits: [
        { hash: 'base', parents: [], subject: 'base', timestamp: 1 },
        { hash: 'left-1', parents: ['base'], subject: 'left 1', timestamp: 2 },
        { hash: 'left-2', parents: ['left-1'], subject: 'left 2', timestamp: 3 },
        { hash: 'right-1', parents: ['base'], subject: 'right 1', timestamp: 4 },
        { hash: 'merge', parents: ['left-2', 'right-1'], subject: 'merge', timestamp: 5 },
        { hash: 'orphan-base', parents: [], subject: 'orphan base', timestamp: 1 },
        { hash: 'orphan-tip', parents: ['orphan-base'], subject: 'orphan tip', timestamp: 6 },
      ],
      branches: [
        { name: 'main', head: 'merge', merged: false },
        { name: 'right', head: 'right-1', merged: true },
        { name: 'orphan', head: 'orphan-tip', merged: false },
      ],
    });
    const raw = buildAttentionTopology(repo, []);
    expectClearParentTracks(raw);
    expectClearParentTracks(compactAttentionTopology(raw));
  });
});
