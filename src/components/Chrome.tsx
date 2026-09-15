import { truncate } from "../lib/text.ts";
import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { attrs, glyph, theme } from "../theme.ts";
import { useApp, type Connection } from "../state/app-context.tsx";
import { KeyHints, StatusPill, type KeyHint } from "./primitives.tsx";

function connColor(c: Connection): string {
  switch (c.status) {
    case "ok":
      return theme.success;
    case "checking":
      return theme.warn;
    case "error":
      return theme.danger;
    default:
      return theme.textFaint;
  }
}

function connLabel(name: string, c: Connection): string {
  switch (c.status) {
    case "ok":
      return c.label ?? name;
    case "checking":
      return `${name}…`;
    case "error":
      return `${name} failed`;
    default:
      return `${name} not linked`;
  }
}

function Header({ crumbs }: { crumbs: string[] }) {
  const { issues, github, config } = useApp();
  const { width } = useTerminalDimensions();
  const showConnections = width >= 90;
  const issueLabel = connLabel(config.issueProvider ?? "linear", issues);
  const githubLabel = connLabel("github", github);
  const reserve = showConnections ? Math.min(40, issueLabel.length + githubLabel.length + 9) : 0;
  const trail = truncate(crumbs.join(`  ${glyph.chevron} `), Math.max(5, width - 19 - reserve));
  return <box flexDirection="row" height={1} flexShrink={0} paddingLeft={2} paddingRight={2} alignItems="center">
    <text height={1} flexShrink={0}>
      <span fg={theme.accent}>{glyph.logo}</span>
      <span fg={theme.white} attributes={attrs.bold}>{" maestro"}</span>
      <span fg={theme.textFaint}>{`  ${glyph.chevron} `}</span>
      <span fg={theme.heading}>{trail}</span>
    </text>
    <box flexGrow={1} />
    {showConnections ? <text height={1} flexShrink={0}>
      <StatusPill label={truncate(issueLabel, 17)} color={connColor(issues)} />
      <span>{"   "}</span>
      <StatusPill label={truncate(githubLabel, 17)} color={connColor(github)} />
    </text> : null}
  </box>;
}

function Footer({ hints }: { hints: KeyHint[] }) {
  const { toast } = useApp();
  const { width } = useTerminalDimensions();

  // A toast takes over the footer line rather than floating over content —
  // no layout shift, nothing obscured.
  if (toast) {
    const color =
      toast.kind === "success" ? theme.success : toast.kind === "error" ? theme.danger : theme.accent;
    return (
      <box flexDirection="row" height={1} paddingLeft={2} paddingRight={2}>
        <text>
          <span fg={color} attributes={attrs.bold}>
            {toast.kind === "error" ? glyph.cross : toast.kind === "success" ? glyph.check : glyph.dot}
          </span>
          <span fg={theme.text}>{" " + toast.text}</span>
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="row" height={1} paddingLeft={2} paddingRight={2}>
      <KeyHints hints={hints} width={Math.max(20, width - 4)} />
    </box>
  );
}

/**
 * Standard page frame: fixed header, flexible body, fixed footer. Views only
 * ever render into the body, so chrome stays put across navigation.
 */
export function Shell({
  crumbs,
  hints,
  children,
}: {
  crumbs: string[];
  hints: KeyHint[];
  children: ReactNode;
}) {
  return (
    <box flexDirection="column" flexGrow={1}>
      <Header crumbs={crumbs} />
      <box height={1} border={["bottom"]} borderStyle="single" borderColor={theme.border} />
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </box>
      <box height={1} border={["top"]} borderStyle="single" borderColor={theme.border} />
      <Footer hints={hints} />
    </box>
  );
}
