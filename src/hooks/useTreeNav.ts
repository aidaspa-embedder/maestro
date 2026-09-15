import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyEvent } from "@opentui/core";

/**
 * Two-axis navigation over a tree: ↑↓ move between *siblings at the current
 * level*, ←→ change level. A whole subtree is the selection at level 0, so ↓
 * jumps ticket-to-ticket past however many children they have; press → and the
 * same ↑↓ now walk that ticket's pull requests.
 *
 * Depth is not hard-coded anywhere: a node with children is a level, so adding
 * a third tier later costs nothing here.
 */

export interface TreeNode<T> {
  /** Stable key for React and for identity across polls */
  id: string;
  value: T;
  children: TreeNode<T>[];
  /** Children exist but aren't rows right now */
  collapsed?: boolean;
  /** What one level down is called — the footer says "→ pull requests" */
  childLabel?: string;
}

export interface TreeRow<T> {
  node: TreeNode<T>;
  value: T;
  /** Index at each level, e.g. [2, 0] is the first child of the third root */
  path: number[];
  depth: number;
  /** Last of its siblings — draws └ rather than ├ */
  last: boolean;
}

export interface TreeNav<T> {
  /** Rows currently on screen, in render order */
  rows: TreeRow<T>[];
  /** First visible row — the scroll window offset */
  start: number;
  path: number[];
  depth: number;
  /** Flat row index of the focused node, -1 when the tree is empty */
  index: number;
  focused: TreeRow<T> | undefined;
  /** The row is the focused node, or inside it — the solid selection */
  selected: (row: TreeRow<T>) => boolean;
  /** The row is a sibling or ancestor of the focus — the level you're inside */
  inScope: (row: TreeRow<T>) => boolean;
  /** What ↑↓ walk right now */
  levelLabel: string;
  /** What → would descend into, when there is one */
  childLabel: string | undefined;
  /** What ← would return to, when there is one */
  parentLabel: string | undefined;
  setPath: (path: number[]) => void;
  /** Read synchronously in key handlers — see the same-tick note in useListNav */
  getPath: () => number[];
  /** `focused` read synchronously, for the same reason */
  liveFocused: () => TreeRow<T> | undefined;
  /** Wire into useKeyboard; false means "I didn't use this key" */
  handleKey: (key: KeyEvent) => boolean;
}

function flatten<T>(nodes: TreeNode<T>[], prefix: number[], out: TreeRow<T>[]): void {
  nodes.forEach((node, i) => {
    const path = [...prefix, i];
    out.push({ node, value: node.value, path, depth: prefix.length, last: i === nodes.length - 1 });
    if (!node.collapsed) flatten(node.children, path, out);
  });
}

/** The sibling array `path`'s last index points into. */
function siblingsAt<T>(roots: TreeNode<T>[], path: number[]): TreeNode<T>[] {
  let level = roots;
  for (let i = 0; i < path.length - 1; i++) {
    const node = level[path[i]!];
    if (!node) return [];
    level = node.children;
  }
  return level;
}

function nodeAt<T>(roots: TreeNode<T>[], path: number[]): TreeNode<T> | undefined {
  let level = roots;
  let node: TreeNode<T> | undefined;
  for (const i of path) {
    node = level[i];
    if (!node) return undefined;
    level = node.children;
  }
  return node;
}

/**
 * Pulls a path back onto the tree as it is now. Folding a branch, filtering the
 * list or a PR disappearing mid-poll all have to leave the cursor somewhere
 * real rather than pointing into thin air.
 */
function clampPath<T>(roots: TreeNode<T>[], path: number[]): number[] {
  const out: number[] = [];
  let level = roots;
  for (const raw of path) {
    if (level.length === 0) break;
    const i = Math.min(Math.max(0, raw), level.length - 1);
    out.push(i);
    const node = level[i]!;
    if (node.collapsed || node.children.length === 0) break;
    level = node.children;
  }
  if (out.length === 0 && roots.length > 0) out.push(0);
  return out;
}

const isPrefix = (prefix: number[], of: number[]): boolean =>
  prefix.length <= of.length && prefix.every((n, i) => of[i] === n);

const same = (a: number[], b: number[]): boolean => a.length === b.length && isPrefix(a, b);

export function useTreeNav<T>(
  roots: TreeNode<T>[],
  viewport: number,
  opts: { rootLabel?: string; vimKeys?: boolean; wrap?: boolean } = {},
): TreeNav<T> {
  const rootLabel = opts.rootLabel ?? "rows";
  const vimKeys = opts.vimKeys ?? true;
  const wrap = opts.wrap ?? true;

  const [rawPath, setRawPath] = useState<number[]>([0]);
  const [start, setStart] = useState(0);

  const rows = useMemo(() => {
    const out: TreeRow<T>[] = [];
    flatten(roots, [], out);
    return out;
  }, [roots]);

  const path = useMemo(() => clampPath(roots, rawPath), [roots, rawPath]);
  // Mirrors `path` but updates synchronously, so same-tick keypresses compose.
  const pathRef = useRef(path);
  pathRef.current = path;

  const index = rows.findIndex((row) => same(row.path, path));
  const focused = index >= 0 ? rows[index] : undefined;

  // The selection's extent: at level 0 that's a whole ticket and its PRs, which
  // is what the scroll window tries to keep whole.
  let groupFrom = index;
  let groupTo = index;
  if (index >= 0) {
    for (let i = index + 1; i < rows.length && isPrefix(path, rows[i]!.path); i++) groupTo = i;
  }

  const size = Math.max(1, viewport);
  const maxStart = Math.max(0, rows.length - size);
  let window = start;
  if (index >= 0) {
    if (groupTo - groupFrom + 1 <= size) {
      if (groupFrom < window) window = groupFrom;
      else if (groupTo >= window + size) window = groupTo - size + 1;
    } else if (index < window) window = index;
    else if (index >= window + size) window = index - size + 1;
  }
  window = Math.min(Math.max(0, window), maxStart);

  // Rendering uses `window` directly, so scrolling never lags a frame; the
  // state catches up so the next keypress starts from where the eye is.
  useEffect(() => {
    if (window !== start) setStart(window);
  }, [window, start]);

  const setPath = useCallback((next: number[]) => {
    const clamped = clampPath(roots, next);
    pathRef.current = clamped;
    setRawPath(clamped);
  }, [roots]);

  const move = useCallback(
    (delta: number) => {
      const current = pathRef.current;
      const depth = current.length - 1;
      if (depth < 0) return;
      const siblings = siblingsAt(roots, current);
      if (siblings.length === 0) return;

      const next = [...current];
      const raw = current[depth]! + delta;
      next[depth] =
        wrap && Math.abs(delta) === 1
          ? (raw + siblings.length) % siblings.length
          : Math.min(Math.max(0, raw), siblings.length - 1);
      setPath(next);
    },
    [roots, wrap, setPath],
  );

  const descend = useCallback((): boolean => {
    const current = pathRef.current;
    const node = nodeAt(roots, current);
    // A folded branch is the view's business: it expands, and the next → enters.
    if (!node || node.collapsed || node.children.length === 0) return false;
    setPath([...current, 0]);
    return true;
  }, [roots, setPath]);

  const ascend = useCallback((): boolean => {
    const current = pathRef.current;
    if (current.length <= 1) return false;
    setPath(current.slice(0, -1));
    return true;
  }, [setPath]);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      const page = Math.max(1, size - 1);
      switch (key.name) {
        case "up":
          move(-1);
          return true;
        case "down":
          move(1);
          return true;
        case "k":
          if (!vimKeys || key.ctrl || key.meta) return false;
          move(-1);
          return true;
        case "j":
          if (!vimKeys || key.ctrl || key.meta) return false;
          move(1);
          return true;
        case "pageup":
          move(-page);
          return true;
        case "pagedown":
          move(page);
          return true;
        case "home":
          move(-Infinity);
          return true;
        case "end":
          move(Infinity);
          return true;
        case "right":
          return descend();
        case "left":
          return ascend();
        default:
          return false;
      }
    },
    [move, descend, ascend, size, vimKeys],
  );

  /** The name of the level `depth` sits at, taken from the node above it. */
  const labelAt = (depth: number): string => {
    if (depth <= 0) return rootLabel;
    const parent = nodeAt(roots, path.slice(0, depth));
    return parent?.childLabel ?? "items";
  };

  const depth = Math.max(0, path.length - 1);
  const focusedNode = focused?.node;
  const hasChildren = Boolean(focusedNode && focusedNode.children.length > 0);

  return {
    rows,
    start: window,
    path,
    depth,
    index,
    focused,
    selected: (row) => index >= 0 && isPrefix(path, row.path),
    inScope: (row) => depth > 0 && isPrefix(path.slice(0, -1), row.path),
    levelLabel: labelAt(depth),
    childLabel: hasChildren ? (focusedNode!.childLabel ?? "items") : undefined,
    parentLabel: depth > 0 ? labelAt(depth - 1) : undefined,
    setPath,
    getPath: () => pathRef.current,
    liveFocused: () => rows.find((row) => same(row.path, pathRef.current)),
    handleKey,
  };
}
