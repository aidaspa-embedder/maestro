import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { attrs, theme } from "../../theme.ts";
import { introLogo } from "./logo.ts";

export const INTRO_DURATION_MS = 1800;

/** Terminal-cell wipe: approach, reveal, glide out, then hold the wordmark. */
export function logoRevealFrame(elapsedMs: number, width: number, height = 24) {
  const logo = introLogo(width, height);
  const logoColumn = Math.max(0, Math.floor((width - logo.width) / 2));
  const approach = Math.min(6, logoColumn);
  const exit = Math.max(0, Math.min(3, width - logoColumn - logo.width - 1));
  const elapsed = Math.max(0, elapsedMs);
  let position: number;
  if (elapsed < 300) {
    position = -approach * (1 - elapsed / 300) ** 2;
  } else if (elapsed < 1100) {
    position = logo.width * (elapsed - 300) / 800;
  } else {
    position = logo.width + exit * (1 - (1 - Math.min(1, (elapsed - 1100) / 250)) ** 2);
  }
  return {
    logo,
    logoColumn,
    revealed: Math.max(0, Math.min(logo.width, Math.floor(position))),
    caretColumn: elapsed < 1350 ? Math.min(Math.max(0, width - 1), logoColumn + Math.floor(position)) : null,
  };
}

/** Static presentation also used to capture exact animation stages in previews. */
export function LogoReveal({ elapsedMs }: { elapsedMs: number }) {
  const { width, height } = useTerminalDimensions();
  const { logo, logoColumn, revealed, caretColumn } = logoRevealFrame(elapsedMs, width, height);
  return <box flexGrow={1} flexDirection="column" justifyContent="center">
    {logo.lines.map((line, i) => <box key={i} width={width} height={1} flexShrink={0} overflow="hidden">
      <text position="absolute" left={logoColumn} top={0} height={1}>
        <span fg={theme.accent}>{line.mark.slice(0, revealed)}</span>
        <span fg={theme.white} attributes={attrs.bold}>{line.word.slice(0, Math.max(0, revealed - logo.markWidth))}</span>
      </text>
      {caretColumn !== null ? <text position="absolute" left={caretColumn} top={0} height={1} fg={theme.accent}>{"|"}</text> : null}
    </box>)}
  </box>;
}

export function Intro({ reduced, onDone }: { reduced: boolean; onDone: () => void }) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const done = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onDoneRef.current();
  }, []);
  useEffect(() => {
    if (reduced) { finish(); return; }
    const start = performance.now();
    const timer = setInterval(() => {
      if (!done.current) setElapsedMs(performance.now() - start);
    }, 1000 / 30);
    const end = setTimeout(() => {
      clearInterval(timer);
      finish();
    }, INTRO_DURATION_MS);
    return () => { clearInterval(timer); clearTimeout(end); };
  }, [reduced, finish]);
  useKeyboard(key => {
    if (key.name === "return" || key.name === "escape" || key.name === "space") {
      key.preventDefault();
      finish();
    }
  });
  return <LogoReveal elapsedMs={elapsedMs} />;
}
