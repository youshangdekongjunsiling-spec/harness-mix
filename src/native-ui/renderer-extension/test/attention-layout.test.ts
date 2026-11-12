import { describe, expect, it } from 'vitest';
import { attentionAnchor, attentionGraph, attentionLanes, attentionProjectId } from '../src/attention-layout.js';
import { EMPTY_ATTENTION_DATA, type AttentionRepository, type AttentionThread } from '../src/attention-types.js';

const repo: AttentionRepository = {
  id: '/repo/.git', root: '/repo', paths: ['/repo', '/wt'], available: true, defaultBranch: 'main', truncated: false,
  commits: [{ hash: 'base', parents: [], subject: 'base', timestamp: 99 }, { hash: 'tip', parents: ['base'], subject: 'tip', timestamp: 1 }],
  branches: [{ name: 'main', head: 'base', merged: true }, { name: 'feature', head: 'tip', merged: false }],
  worktrees: [{ path: '/repo', branch: 'main', head: 'base', dirty: 0, detached: false }, { path: '/wt', branch: 'feature', head: 'tip', dirty: 2, detached: false }],
};
const thread: AttentionThread = { id: 't', title: 'Implement', harnessId: 'claude', cwd: '/wt', projectId: null, updatedAt: 1, status: 'running' };

describe('attention anchors and topology', () => {
  it('follows verified managed worktree HEAD/WIP and retains native recorded baseline', () => {
    expect(attentionAnchor({ ...thread, source: 'harnessmix', workspace: { mode: 'worktree', root: '/wt', branch: 'feature' } }, [repo]))
      .toMatchObject({ kind: 'workspace', branch: 'feature', hash: 'tip', dirty: 2 });
    expect(attentionAnchor({ ...thread, harnessId: 'codex', gitInfo: { branch: 'feature', sha: 'base' } }, [repo])).toMatchObject({ kind: 'commit', hash: 'base', dirty: null });
  });
  it('does not move a historical conversation onto a later checkout', () => {
    expect(attentionAnchor({ ...thread, gitInfo: { branch: 'old', sha: 'old-tip' } }, [repo])).toMatchObject({ kind: 'commit', branch: 'old', hash: 'old-tip', dirty: null });
    expect(attentionLanes([{ ...thread, gitInfo: { branch: 'old', sha: 'old-tip' } }], [repo]).find(l => l.name === 'old')?.head).toBeNull();
  });
  it('uses verified activity to follow a native thread after a dynamic branch switch', () => {
    const activeNative = { ...thread, harnessId: 'codex', source: 'native' as const,
      gitInfo: { branch: 'main', sha: 'base' }, activity: { cwd: '/wt', observedAt: 10, source: 'command' as const } };
    expect(attentionAnchor(activeNative, [repo])).toMatchObject({ kind: 'workspace', repository: repo, branch: 'feature', hash: 'tip', dirty: 2 });
  });
  it('prefers the deepest repository and does not fall back past an unavailable exact activity path', () => {
    const umbrella: AttentionRepository = { ...repo, id: 'umbrella', root: '/repo', paths: ['/repo'],
      worktrees: [{ path: '/repo', branch: 'main', head: 'base', dirty: 0, detached: false }] };
    const nested: AttentionRepository = { ...repo, id: 'nested', root: '/repo/nested', paths: ['/repo/nested'],
      worktrees: [{ path: '/repo/nested', branch: 'feature', head: 'tip', dirty: 1, detached: false }] };
    const active = { ...thread, source: 'harnessmix' as const, workspace: { mode: 'worktree', root: '/repo/nested', branch: 'feature' },
      activity: { cwd: '/repo/nested/src', observedAt: 11, source: 'worktree' as const } };
    expect(attentionAnchor(active, [umbrella, nested])).toMatchObject({ repository: nested, branch: 'feature', dirty: 1 });
    const unavailable: AttentionRepository = { ...nested, available: false, commits: [], branches: [], worktrees: [] };
    const exactUnavailable = { ...thread, activity: { cwd: '/repo/nested', observedAt: 12, source: 'command' as const } };
    expect(attentionAnchor(exactUnavailable, [umbrella, unavailable])).toMatchObject({ kind: 'unbound', repository: null, label: '活动位置暂不可用' });
  });
  it('leaves nonrepositories and prefix collisions unbound', () => {
    expect(attentionAnchor({ ...thread, cwd: '/wt-other' }, [repo]).kind).toBe('unbound');
    expect(attentionAnchor({ ...thread, cwd: null }, [repo]).kind).toBe('unbound');
  });
  it('associates shared-cwd conversations without pretending they are at current HEAD', () => {
    const conversations = [
      { ...thread, id: 'idle', status: 'idle' as const },
      { ...thread, id: 'interrupted', status: 'interrupted' as const, gitInfo: { branch: 'feature' } },
      { ...thread, id: 'managed', source: 'harnessmix' as const, status: 'completed' as const, gitInfo: { branch: 'feature' } },
    ];
    for (const conversation of conversations) {
      expect(attentionAnchor(conversation, [repo])).toMatchObject({
        kind: 'commit', repository: repo, branch: 'feature', hash: null, dirty: null,
        label: '已关联仓库 · 尚无提交证据',
      });
    }
  });
  it('does not let historical command cwd move a finished shared-worktree conversation to current HEAD', () => {
    for (const status of ['idle', 'completed', 'interrupted'] as const) {
      const historical = { ...thread, status, source: 'native' as const,
        activity: { cwd: '/wt', observedAt: 10, source: 'command' as const } };
      expect(attentionAnchor(historical, [repo])).toMatchObject({
        kind: 'commit', repository: repo, branch: 'feature', hash: null, dirty: null,
      });
    }
    expect(attentionAnchor({ ...thread, status: 'waiting', source: 'native',
      activity: { cwd: '/wt', observedAt: 11, source: 'command' } }, [repo]))
      .toMatchObject({ kind: 'workspace', hash: 'tip', dirty: 2 });
  });
  it('uses parent topology even with skewed commit timestamps', () => {
    const graph = attentionGraph(attentionLanes([thread], [repo]));
    expect(graph.find(n => n.hash === 'base')!.column).toBeLessThan(graph.find(n => n.hash === 'tip')!.column);
    expect(graph.find(n => n.hash === 'tip')!.parentIds).toEqual(['/repo/.git::base']);
  });
  it('keeps identical commit hashes in different repositories distinct', () => {
    const other = { ...repo, id: '/other/.git', root: '/other', paths: ['/other'], worktrees: [{ path: '/other', branch: 'feature', head: 'tip', dirty: 0, detached: false }] };
    const graph = attentionGraph(attentionLanes([thread, { ...thread, id: 'other', cwd: '/other' }], [repo, other]));
    expect(graph.filter(n => n.hash === 'tip')).toHaveLength(2);
    expect(new Set(graph.map(n => n.id)).size).toBe(graph.length);
  });
  it('keeps every local branch of associated repositories without importing unrelated repositories', () => {
    const associated: AttentionRepository = { ...repo, branches: [...repo.branches, { name: 'release', head: 'base', merged: false }] };
    const unrelated: AttentionRepository = { ...repo, id: '/unrelated/.git', root: '/unrelated', paths: ['/unrelated'],
      branches: [{ name: 'private', head: 'tip', merged: false }], worktrees: [{ path: '/unrelated', branch: 'private', head: 'tip', dirty: 0, detached: false }] };
    const lanes = attentionLanes([thread], [associated, unrelated]);
    expect(lanes.map(lane => lane.name)).toEqual(['main', 'feature', 'release']);
    expect(lanes.find(lane => lane.name === 'main')?.threads).toHaveLength(0);
    expect(lanes.some(lane => lane.repository === unrelated)).toBe(false);
  });
  it('samples a bounded real ancestry while preserving heads and recorded anchors', () => {
    const commits = Array.from({ length: 30 }, (_, index) => ({
      hash: `c${index}`, parents: index ? [`c${index - 1}`] : [], subject: `commit ${index}`, timestamp: index,
    }));
    const chainRepo: AttentionRepository = { ...repo, id: 'chain', root: '/chain', paths: ['/chain'], commits,
      branches: [{ name: 'main', head: 'c29', merged: true }],
      worktrees: [{ path: '/chain', branch: 'main', head: 'c29', dirty: 0, detached: false }] };
    const historical = { ...thread, cwd: '/chain', gitInfo: { branch: 'historical', sha: 'c2' } };
    const graph = attentionGraph(attentionLanes([historical], [chainRepo]));
    expect(graph).toHaveLength(24);
    expect(graph.some(node => node.hash === 'c29')).toBe(true);
    expect(graph.some(node => node.hash === 'c2')).toBe(true);
    for (const node of graph) {
      const commit = commits.find(candidate => candidate.hash === node.hash)!;
      expect(node.parentIds).toEqual(commit.parents.map(parent => `chain::${parent}`));
    }
    expect(graph.find(node => node.hash === 'c28')!.column).toBeLessThan(graph.find(node => node.hash === 'c29')!.column);
  });
  it('matches the most specific saved project root', () => {
    const data = { ...EMPTY_ATTENTION_DATA, projects: [{ id: 'a', name: 'A', rootPaths: ['/repo'] }, { id: 'b', name: 'B', rootPaths: ['/repo/sub'] }] };
    expect(attentionProjectId({ ...thread, cwd: '/repo/sub/src' }, data)).toBe('b');
    expect(attentionProjectId({ ...thread, projectId: 'migrated-native-id', cwd: '/repo/sub/src' }, data)).toBe('b');
  });
});
