import { attentionAnchor } from './attention-layout.js';
import type { AttentionCommit, AttentionRepository, AttentionThread } from './attention-types.js';

export interface AttentionTopologyWorktree {
  path: string;
  branch: string | null;
  dirty: number | null;
  detached: boolean;
}

export interface AttentionTopologyNode {
  id: string;
  hash: string;
  subject: string;
  timestamp: number;
  /** Zero-based position in a newest-to-oldest topological order. */
  row: number;
  /** Zero-based UI page. Pagination never removes nodes from this model. */
  page: number;
  /** Git-graph track at this row; tracks are reused as ancestry converges. */
  track: number;
  parents: string[];
  branches: string[];
  worktrees: AttentionTopologyWorktree[];
}

export interface AttentionTopologyEdge {
  from: string;
  /** Null when the parent is outside the bounded repository snapshot. */
  to: string | null;
  parentIndex: number;
  boundary?: { hash: string } | undefined;
  /** Ordered real commits traversed between from and to. */
  via?: string[] | undefined;
  skippedCount?: number | undefined;
}

export interface AttentionTopologyPin {
  threadId: string;
  nodeId: string;
  hash: string;
  kind: 'workspace' | 'commit';
  dirty: number | null;
  branch: string | null;
  path: string | null;
}

export interface AttentionTopologyUnresolved {
  threadId: string;
  reason: 'unbound' | 'no-hash' | 'missing-commit';
  hash?: string | undefined;
  branch?: string | undefined;
  path: string | null;
}

export interface AttentionTopology {
  nodes: AttentionTopologyNode[];
  edges: AttentionTopologyEdge[];
  pins: AttentionTopologyPin[];
  unresolved: AttentionTopologyUnresolved[];
  trackCount: number;
  missingParents: Array<{ from: string; hash: string }>;
  truncated: boolean;
  pageSize: number;
  pageCount: number;
}

function threadPath(thread: AttentionThread): string | null {
  return thread.activity?.cwd ?? thread.workspace?.root ?? thread.cwd ?? null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function canonicalCommits(commits: readonly AttentionCommit[]): Map<string, AttentionCommit> {
  const result = new Map<string, AttentionCommit>();
  for (const commit of commits) {
    if (!commit.hash || result.has(commit.hash)) continue;
    result.set(commit.hash, {
      hash: commit.hash,
      parents: unique(commit.parents).filter(parent => parent !== commit.hash),
      subject: commit.subject,
      timestamp: Number.isFinite(commit.timestamp) ? commit.timestamp : 0,
    });
  }
  return result;
}

/**
 * Orders every known commit with children before parents. Timestamps only
 * break ties between unrelated tips, so clock skew cannot invert ancestry.
 */
function topologicalOrder(repository: AttentionRepository, commits: Map<string, AttentionCommit>): AttentionCommit[] {
  const knownChildren = new Map<string, number>([...commits.keys()].map(hash => [hash, 0]));
  for (const commit of commits.values()) {
    for (const parent of commit.parents) if (commits.has(parent)) knownChildren.set(parent, (knownChildren.get(parent) ?? 0) + 1);
  }
  const defaultHead = repository.branches.find(branch => branch.name === repository.defaultBranch)?.head;
  const branchHeads = new Set(repository.branches.map(branch => branch.head));
  const worktreeHeads = new Set(repository.worktrees.map(worktree => worktree.head).filter((hash): hash is string => !!hash));
  const priority = (commit: AttentionCommit): [number, number, string] => [
    commit.hash === defaultHead ? 0 : branchHeads.has(commit.hash) ? 1 : worktreeHeads.has(commit.hash) ? 2 : 3,
    -commit.timestamp,
    commit.hash,
  ];
  const compare = (a: AttentionCommit, b: AttentionCommit): number => {
    const aa = priority(a); const bb = priority(b);
    return aa[0] - bb[0] || aa[1] - bb[1] || aa[2].localeCompare(bb[2]);
  };
  const ready = [...commits.values()].filter(commit => knownChildren.get(commit.hash) === 0).sort(compare);
  const ordered: AttentionCommit[] = [];
  const emitted = new Set<string>();
  while (ready.length) {
    const commit = ready.shift()!;
    if (emitted.has(commit.hash)) continue;
    emitted.add(commit.hash);
    ordered.push(commit);
    for (const parent of commit.parents) {
      if (!commits.has(parent)) continue;
      const remaining = (knownChildren.get(parent) ?? 0) - 1;
      knownChildren.set(parent, remaining);
      if (remaining === 0) {
        ready.push(commits.get(parent)!);
        ready.sort(compare);
      }
    }
  }
  // Malformed cyclic data still renders deterministically, while every edge
  // remains the real recorded edge. No synthetic ancestry is introduced.
  ordered.push(...[...commits.values()].filter(commit => !emitted.has(commit.hash)).sort(compare));
  return ordered;
}

function assignTracks(ordered: readonly AttentionCommit[], known: ReadonlySet<string>): { tracks: Map<string, number>; count: number } {
  // Slots never shift while an ancestor is pending. This lets the renderer
  // extend an edge down parent.track without crossing an unrelated node that
  // moved left after another lane completed.
  const active: Array<string | null> = [];
  const tracks = new Map<string, number>();
  let count = 0;
  for (const commit of ordered) {
    let track = active.indexOf(commit.hash);
    if (track < 0) {
      track = active.indexOf(null);
      if (track < 0) {
        track = active.length;
        active.push(commit.hash);
      } else active[track] = commit.hash;
    }
    tracks.set(commit.hash, track);
    const parents = unique(commit.parents).filter(parent => known.has(parent));
    active[track] = null;
    for (const [parentIndex, parent] of parents.entries()) {
      if (active.includes(parent)) continue;
      let parentTrack = parentIndex === 0 ? track : active.indexOf(null);
      if (parentTrack < 0) parentTrack = active.length;
      active[parentTrack] = parent;
    }
    count = Math.max(count, track + 1, ...active.map((value, index) => value === null ? 0 : index + 1));
  }
  return { tracks, count };
}

export function buildAttentionTopology(
  repository: AttentionRepository,
  threads: readonly AttentionThread[],
  pageSize = 10,
): AttentionTopology {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 10;
  const commits = canonicalCommits(repository.commits);
  const ordered = topologicalOrder(repository, commits);
  const { tracks, count } = assignTracks(ordered, new Set(commits.keys()));
  const branchesByHead = new Map<string, string[]>();
  for (const branch of repository.branches) {
    const names = branchesByHead.get(branch.head) ?? [];
    if (!names.includes(branch.name)) names.push(branch.name);
    branchesByHead.set(branch.head, names);
  }
  const worktreesByHead = new Map<string, AttentionTopologyWorktree[]>();
  for (const worktree of repository.worktrees) {
    if (!worktree.head) continue;
    const rows = worktreesByHead.get(worktree.head) ?? [];
    rows.push({ path: worktree.path, branch: worktree.branch, dirty: worktree.dirty, detached: worktree.detached });
    worktreesByHead.set(worktree.head, rows);
  }
  const nodes = ordered.map((commit, row): AttentionTopologyNode => ({
    id: commit.hash,
    hash: commit.hash,
    subject: commit.subject,
    timestamp: commit.timestamp,
    row,
    page: Math.floor(row / safePageSize),
    track: tracks.get(commit.hash) ?? 0,
    parents: [...commit.parents],
    branches: (branchesByHead.get(commit.hash) ?? []).toSorted((a, b) => {
      if (a === repository.defaultBranch) return -1;
      if (b === repository.defaultBranch) return 1;
      return a.localeCompare(b);
    }),
    worktrees: (worktreesByHead.get(commit.hash) ?? []).toSorted((a, b) => a.path.localeCompare(b.path)),
  }));
  const edges: AttentionTopologyEdge[] = [];
  const missingParents: Array<{ from: string; hash: string }> = [];
  for (const commit of ordered) {
    commit.parents.forEach((parent, parentIndex) => {
      if (commits.has(parent)) edges.push({ from: commit.hash, to: parent, parentIndex });
      else {
        edges.push({ from: commit.hash, to: null, parentIndex, boundary: { hash: parent } });
        missingParents.push({ from: commit.hash, hash: parent });
      }
    });
  }
  const pins: AttentionTopologyPin[] = [];
  const unresolved: AttentionTopologyUnresolved[] = [];
  for (const thread of threads) {
    const threadId = String(thread.id);
    const path = threadPath(thread);
    const anchor = attentionAnchor(thread, [repository]);
    if (anchor.kind === 'unbound' || anchor.repository?.id !== repository.id) {
      unresolved.push({ threadId, reason: 'unbound', ...(anchor.branch ? { branch: anchor.branch } : {}), path });
    } else if (!anchor.hash) {
      unresolved.push({ threadId, reason: 'no-hash', ...(anchor.branch ? { branch: anchor.branch } : {}), path });
    } else if (!commits.has(anchor.hash)) {
      unresolved.push({ threadId, reason: 'missing-commit', hash: anchor.hash, ...(anchor.branch ? { branch: anchor.branch } : {}), path });
    } else {
      pins.push({ threadId, nodeId: anchor.hash, hash: anchor.hash, kind: anchor.kind,
        dirty: anchor.dirty, branch: anchor.branch, path });
    }
  }
  return {
    nodes,
    edges,
    pins,
    unresolved,
    trackCount: count,
    missingParents,
    truncated: repository.truncated,
    pageSize: safePageSize,
    pageCount: Math.ceil(nodes.length / safePageSize),
  };
}

/**
 * Produces an overview without hiding structural or annotated commits. Every
 * compact edge carries the exact continuous parent chain it skips.
 */
export function compactAttentionTopology(topology: AttentionTopology): AttentionTopology {
  const nodeById = new Map(topology.nodes.map(node => [node.id, node]));
  const edgesByFrom = new Map<string, AttentionTopologyEdge[]>();
  const childCount = new Map<string, number>();
  for (const edge of topology.edges) {
    const rows = edgesByFrom.get(edge.from) ?? [];
    rows.push(edge);
    edgesByFrom.set(edge.from, rows);
    if (edge.to) childCount.set(edge.to, (childCount.get(edge.to) ?? 0) + 1);
  }
  for (const rows of edgesByFrom.values()) rows.sort((a, b) => a.parentIndex - b.parentIndex);
  const pinned = new Set(topology.pins.map(pin => pin.nodeId));
  const collapsible = new Set(topology.nodes.filter(node => {
    const outgoing = edgesByFrom.get(node.id) ?? [];
    return node.branches.length === 0 && node.worktrees.length === 0 && !pinned.has(node.id)
      && node.parents.length === 1 && outgoing.length === 1 && !!outgoing[0]?.to
      && (childCount.get(node.id) ?? 0) === 1;
  }).map(node => node.id));
  const retained = topology.nodes.filter(node => !collapsible.has(node.id));
  const edges: AttentionTopologyEdge[] = [];
  for (const node of retained) {
    for (const original of edgesByFrom.get(node.id) ?? []) {
      let current = original;
      const via: string[] = [];
      const visited = new Set<string>();
      while (current.to && collapsible.has(current.to) && !visited.has(current.to)) {
        visited.add(current.to);
        via.push(current.to);
        const next = edgesByFrom.get(current.to)?.[0];
        if (!next) break;
        current = next;
      }
      edges.push({
        from: node.id,
        to: current.to,
        parentIndex: original.parentIndex,
        ...(current.boundary ? { boundary: current.boundary } : {}),
        ...(via.length ? { via, skippedCount: via.length } : {}),
      });
    }
  }
  const effectiveCommits = retained.map(node => ({
    hash: node.id,
    parents: edges.filter(edge => edge.from === node.id && edge.to).map(edge => edge.to!),
    subject: node.subject,
    timestamp: node.timestamp,
  }));
  const { tracks, count } = assignTracks(effectiveCommits, new Set(retained.map(node => node.id)));
  const nodes = retained.map((node, row) => ({
    ...node,
    row,
    page: Math.floor(row / topology.pageSize),
    track: tracks.get(node.id) ?? 0,
  }));
  const missingParents = edges.filter(edge => edge.boundary).map(edge => ({ from: edge.from, hash: edge.boundary!.hash }));
  return {
    ...topology,
    nodes,
    edges,
    trackCount: count,
    missingParents,
    pageCount: Math.ceil(nodes.length / topology.pageSize),
  };
}
