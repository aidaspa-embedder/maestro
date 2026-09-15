import { createContext, useContext, useSyncExternalStore } from "react";
export const MotionContext = createContext(false);
let frame = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => { frame = (frame + 1) % 10; for (const notify of listeners) notify(); }, 100);
  return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined; } };
}
const noMotion = () => () => {};
/** All spinners share one clock, stopped when no animated component is visible. */
export function useSpinnerFrame(): number {
  const reduced = useContext(MotionContext) || process.env.MAESTRO_REDUCED_MOTION === "1";
  const value = useSyncExternalStore(reduced ? noMotion : subscribe, () => frame, () => 0);
  return reduced ? 0 : value;
}
