import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyEvent } from "@opentui/core";

export interface ListNav {
  index: number;
  /** First visible row — the scroll window offset */
  start: number;
  setIndex: (i: number) => void;
  move: (delta: number) => void;
  /**
   * The current index read synchronously. Key handlers must use this rather
   * than `index`: two keypresses can land in the same tick (key repeat, a fast
   * typist), and the second would otherwise act on the pre-render value.
   */
  getIndex: () => number;
  /** Wire into useKeyboard; returns true when the key was consumed. */
  handleKey: (key: KeyEvent) => boolean;
}

/**
 * Keyboard list navigation with a scroll window. Owning the window (rather than
 * using a scrollbox) keeps selection and viewport in lockstep, which is what
 * makes long lists feel tight.
 */
export function useListNav(
  count: number,
  viewport: number,
  opts: { wrap?: boolean; vimKeys?: boolean } = {},
): ListNav {
  const wrap = opts.wrap ?? true;
  // Views with a focused text input must not steal j/k from typing.
  const vimKeys = opts.vimKeys ?? true;
  const [index, setIndexRaw] = useState(0);
  const [start, setStart] = useState(0);
  // Mirrors `index` but updates synchronously, so same-tick keypresses compose.
  const indexRef = useRef(0);

  const clampWindow = useCallback(
    (i: number, currentStart: number) => {
      const size = Math.max(1, viewport);
      const maxStart = Math.max(0, count - size);
      let next = currentStart;
      if (i < next) next = i;
      else if (i >= next + size) next = i - size + 1;
      return Math.min(Math.max(0, next), maxStart);
    },
    [count, viewport],
  );

  const setIndex = useCallback(
    (i: number) => {
      const bounded = count === 0 ? 0 : Math.min(Math.max(0, i), count - 1);
      indexRef.current = bounded;
      setIndexRaw(bounded);
      setStart((s) => clampWindow(bounded, s));
    },
    [count, clampWindow],
  );

  const move = useCallback(
    (delta: number) => {
      if (count === 0) return;
      // Read the ref, not state: consecutive arrows in one tick must accumulate.
      let next = indexRef.current + delta;
      if (wrap && count > 0) {
        if (next < 0) next = Math.abs(delta) === 1 ? count - 1 : 0;
        else if (next > count - 1) next = Math.abs(delta) === 1 ? 0 : count - 1;
      }
      setIndex(next);
    },
    [count, wrap, setIndex],
  );

  // Keep selection valid when the list shrinks under us (e.g. search filtering).
  useEffect(() => {
    if (index > count - 1) setIndex(count - 1);
    else setStart((s) => clampWindow(index, s));
  }, [count, viewport]);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      const page = Math.max(1, viewport - 1);
      switch (key.name) {
        case "up":
          move(-1);
          return true;
        case "down":
          move(1);
          return true;
        case "pageup":
          move(-page);
          return true;
        case "pagedown":
          move(page);
          return true;
        case "home":
          setIndex(0);
          return true;
        case "end":
          setIndex(count - 1);
          return true;
        case "k":
          if (!vimKeys || key.ctrl || key.meta) return false;
          move(-1);
          return true;
        case "j":
          if (!vimKeys || key.ctrl || key.meta) return false;
          move(1);
          return true;
        default:
          return false;
      }
    },
    [move, setIndex, count, viewport, vimKeys],
  );

  const getIndex = useCallback(() => indexRef.current, []);

  return { index, start, setIndex, move, getIndex, handleKey };
}
