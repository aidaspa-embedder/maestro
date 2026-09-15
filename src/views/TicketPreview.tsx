import { linearProvider, type IssueProvider } from "../integrations/issues/index.ts";
import { useMemo, useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { Lines, Spinner } from "../components/primitives.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { buildTicketLines } from "../lib/ticket.ts";
import type { IssueDetail } from "../services/linear.ts";
import type { IssueTicket } from "../state/types.ts";
import { attrs, glyph, theme } from "../theme.ts";

/**
 * The whole Linear ticket, rendered in the terminal: metadata, the description
 * as real markdown, sub-issues and the comment thread. Scrolls by line so a
 * long spec is readable rather than merely present.
 */
export function useTicketPreview(apiKey: string | undefined, ticket: IssueTicket, width: number, provider?: IssueProvider) {
  const detail = useAsync<IssueDetail>(
    () => (provider ?? linearProvider(apiKey)).issueDetail(ticket.id),
    [ticket.id, apiKey, provider],
    { enabled: Boolean(provider?.configured ?? apiKey) },
  );

  const lines = useMemo(
    () =>
      buildTicketLines(ticket, detail.data, width, {
        loading: detail.loading,
        error: (provider?.configured ?? apiKey) ? detail.error : `${provider?.label ?? "Linear"} is not linked — add credentials in settings`,
      }),
    [ticket, detail.data, detail.loading, detail.error, apiKey, width, provider],
  );

  return {
    lines,
    detail: detail.data,
    loading: detail.loading,
    error: detail.error,
    reload: detail.reload,
  };
}

/** Line-based scrolling. Kept separate so the parent view owns the keymap. */
export function useScroll(total: number, viewport: number) {
  const [offset, setOffset] = useState(0);
  const max = Math.max(0, total - viewport);
  const clamped = Math.min(offset, max);

  // Updater form, not `clamped + delta`: key repeat lands several presses in
  // one tick, and every one of them has to count.
  const by = (delta: number) => setOffset((o) => Math.min(max, Math.max(0, o + delta)));

  const handleKey = (key: KeyEvent): boolean => {
    switch (key.name) {
      case "up":
      case "k":
        by(-1);
        return true;
      case "down":
      case "j":
        by(1);
        return true;
      case "pageup":
        by(-Math.max(1, viewport - 1));
        return true;
      case "pagedown":
      case "space":
        by(Math.max(1, viewport - 1));
        return true;
      case "home":
        setOffset(0);
        return true;
      case "end":
        setOffset(max);
        return true;
      default:
        return false;
    }
  };

  return { offset: clamped, max, atTop: clamped === 0, atEnd: clamped >= max, handleKey, reset: () => setOffset(0) };
}

export function TicketBody({
  lines,
  offset,
  viewport,
  loading,
  more,
}: {
  lines: ReturnType<typeof buildTicketLines>;
  offset: number;
  viewport: number;
  loading: boolean;
  /** Rows still below the fold, so the reader knows to keep going */
  more: number;
}) {
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <Lines lines={lines.slice(offset, offset + viewport)} />
      <box flexGrow={1} />
      {loading ? (
        <box height={1}>
          <text>
            <Spinner />
            <span fg={theme.textFaint}>{" loading ticket…"}</span>
          </text>
        </box>
      ) : more > 0 ? (
        <box height={1}>
          <text fg={theme.textFaint} attributes={attrs.italic}>
            {`${glyph.twistyOpen} ${more} more line${more === 1 ? "" : "s"}`}
          </text>
        </box>
      ) : null}
    </box>
  );
}
