import { useRef } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { theme } from "../theme.ts";

/** Secret bytes never reach a terminal renderable, including during bracketed paste. */
export function SecretInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const live = useRef(value);
  live.current = value;
  const set = (next: string) => { live.current = next.slice(0, 8192); onChange(live.current); };
  usePaste(event => {
    event.preventDefault();
    set(live.current + new TextDecoder().decode(event.bytes).replace(/[\x00-\x20\x7f]/g, ""));
  });
  useKeyboard(key => {
    if (key.defaultPrevented) return;
    if (key.ctrl && key.name === "u") { key.preventDefault(); set(""); }
    else if (key.name === "backspace") { key.preventDefault(); set(live.current.slice(0, -1)); }
    else if (!key.ctrl && !key.meta && !key.option && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) {
      key.preventDefault(); set(live.current + key.sequence);
    }
  });
  return <text fg={theme.heading}>{value ? "•".repeat(Math.min(36, value.length)) + " ▏" : "paste new secret here ▏"}</text>;
}
