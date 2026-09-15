import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { EmptyState, Spinner } from "../../components/primitives.tsx";
import { useAsync } from "../../hooks/useAsync.ts";
import { useDebounced } from "../../hooks/useDebounced.ts";
import { useTreeNav, type TreeNode, type TreeRow } from "../../hooks/useTreeNav.ts";
import { searchInputBindings } from "../../lib/keybindings.ts";
import { pad, truncate } from "../../lib/text.ts";
import { flattenTickets, type TicketNode } from "../../services/linear.ts";
import { linearProvider, type IssueProvider } from "../../integrations/issues/index.ts";
import type { IssueTicket } from "../../state/types.ts";
import { attrs, glyph, idColor, theme, ticketStyle, transparent } from "../../theme.ts";

const CURSOR_W = 2;
const TREE_W = 3;
const ID_W = 10;
const STATE_W = 16;
const CHROME_ROWS = 10;

/**
 * What the picker's ↑↓ and ←→ are currently doing. The footer lives in the
 * shell, so the level has to travel up rather than being rendered here.
 */
export interface PickerLevel {
  /** What ↑↓ walk right now */
  label: string;
  /** Named when → would descend into something */
  child?: string;
  /** Named when ← would climb back out */
  parent?: string;
  /** Identifier of the ticket you've descended into, for the breadcrumb */
  inside?: string;
  empty: boolean;
}

/**
 * The ticket list is a tree: sub-issues hang off their parent and are picked
 * the same way it is. ↑↓ stay on one level and ←→ change level, exactly as in
 * the workspace list — see useTreeNav.
 */
export function TicketPicker({
  apiKey,
  provider: suppliedProvider,
  onPick,
  onNew,
  onCancel,
  onLevel,
}: {
  apiKey?: string;
  provider?: IssueProvider;
  onPick: (ticket: IssueTicket) => void;
  /** ^n — create a brand-new ticket instead of picking an existing one */
  onNew?: () => void;
  onCancel: () => void;
  onLevel: (level: PickerLevel) => void;
}) {
  const provider = suppliedProvider ?? linearProvider(apiKey);
  const { height, width } = useTerminalDimensions();
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 260);

  const { data, loading, error } = useAsync<TicketNode[]>(
    () => (debounced.length >= 2 ? provider.searchIssues(debounced) : provider.myIssues()),
    [debounced, apiKey, suppliedProvider],
  );

  const nodes = data ?? [];
  const total = useMemo(() => flattenTickets(nodes).length, [nodes]);

  // Sub-issues are the reason you're looking at this list, so nothing here
  // folds — ← always means "back up a level".
  const tree = useMemo<TreeNode<IssueTicket>[]>(() => nodes.map(toTreeNode), [nodes]);

  const viewport = Math.max(1, height - CHROME_ROWS);
  // No vim keys: every letter has to reach the search box.
  const nav = useTreeNav<IssueTicket>(tree, viewport, { rootLabel: "tickets", vimKeys: false });

  // The shell owns the footer and the breadcrumb, so the level is reported up.
  // Depending on the primitives keeps this to one call per actual change.
  useEffect(() => {
    onLevel({
      label: nav.levelLabel,
      child: nav.childLabel,
      parent: nav.parentLabel,
      inside: nav.depth > 0 ? tree[nav.path[0]!]?.value.identifier : undefined,
      empty: nav.rows.length === 0,
    });
  }, [nav.levelLabel, nav.childLabel, nav.parentLabel, nav.depth, nav.path[0], nav.rows.length, tree]);

  useKeyboard((key) => {
    // Claiming a key stops the focused search input from also receiving it.
    // Only non-printable keys are claimed, so search stays fully typeable.
    const claim = () => key.preventDefault();

    if (key.name === "escape") {
      claim();
      onCancel();
      return;
    }
    if (key.name === "return") {
      claim();
      const row = nav.liveFocused();
      if (row) onPick(row.value);
      return;
    }
    // ctrl so plain `n` stays typeable in the search box.
    if (key.name === "n" && key.ctrl && onNew) {
      claim();
      onNew();
      return;
    }
    // ←→ are only claimed when there is a level to move to; otherwise they fall
    // through to the input as ordinary cursor movement.
    if (nav.handleKey(key)) claim();
  });

  const titleW = Math.max(10, width - 4 - CURSOR_W - TREE_W - ID_W - STATE_W);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexDirection="row" height={1}>
        <text>
          <span fg={theme.accentBright} attributes={attrs.bold}>{glyph.chevron + " "}</span>
        </text>
        <input
          focused
          value={query}
          onInput={setQuery}
          keyBindings={searchInputBindings}
          flexGrow={1}
          backgroundColor={transparent}
          focusedBackgroundColor={transparent}
          textColor={theme.white}
          cursorColor={theme.accent}
          placeholderColor={theme.textFaint}
          placeholder="search tickets — empty shows your assigned issues"
        />
        {loading ? (
          <text>
            <Spinner />
          </text>
        ) : (
          <text fg={theme.textFaint}>{total ? String(total) : ""}</text>
        )}
      </box>

      <box height={1} />

      {error ? (
        <EmptyState title={error} hint={`Check ${provider.label} credentials in settings`} />
      ) : nav.rows.length === 0 && !loading ? (
        <EmptyState
          title={debounced ? `No tickets matching "${debounced}"` : "No open issues assigned to you"}
          hint="Type to search the whole workspace"
        />
      ) : (
        <box flexDirection="column">
          {nav.rows.slice(nav.start, nav.start + viewport).map((row, i) => (
            <Row
              key={row.node.id}
              row={row}
              focused={nav.start + i === nav.index}
              selected={nav.selected(row)}
              scoped={nav.inScope(row)}
              titleW={titleW}
            />
          ))}
        </box>
      )}
    </box>
  );
}

function toTreeNode(node: TicketNode): TreeNode<IssueTicket> {
  return {
    id: node.ticket.id,
    value: node.ticket,
    childLabel: "sub-issues",
    children: node.children.map(toTreeNode),
  };
}

function Row({
  row,
  focused,
  selected,
  scoped,
  titleW,
}: {
  row: TreeRow<IssueTicket>;
  /** The cursor is on this exact row */
  focused: boolean;
  /** This row is the focused node, or nested inside it */
  selected: boolean;
  /** This row is a sibling or ancestor of the focus — the level you're in */
  scoped: boolean;
  titleW: number;
}) {
  const ticket = row.value;
  const state = ticketStyle(ticket.stateType);
  const done = ticket.stateType === "completed" || ticket.stateType === "canceled";

  return (
    <box flexDirection="row" height={1} backgroundColor={selected ? theme.selBg : undefined}>
      <text>
        <span fg={selected ? theme.accent : theme.accentDim}>
          {selected ? glyph.box : scoped ? glyph.rail : " "}
        </span>
        <span>{" "}</span>
        <TreeCell depth={row.depth} last={row.last} />
        <span fg={idColor(row.depth, { selected, muted: done })} attributes={attrs.bold}>
          {pad(truncate(ticket.identifier, ID_W - 1), ID_W)}
        </span>
        <span
          fg={done ? theme.textFaint : focused ? theme.white : theme.text}
          attributes={focused ? attrs.bold : done ? attrs.strike : undefined}
        >
          {pad(truncate(ticket.title, titleW - 1), titleW)}
        </span>
        <span fg={state.color} attributes={attrs.bold}>{state.glyph}</span>
        <span fg={state.color}>{pad(" " + truncate(ticket.stateName, STATE_W - 3), STATE_W - 1)}</span>
      </text>
    </box>
  );
}

/**
 * The connector into a parent. Depth beyond one nests by indent alone — Linear
 * sub-issues are effectively one level, and a full ancestor rail would cost
 * more columns than it explains.
 */
function TreeCell({ depth, last }: { depth: number; last: boolean }) {
  if (depth === 0) return <span>{" ".repeat(TREE_W)}</span>;
  return (
    <span>
      <span>{"  ".repeat(depth - 1)}</span>
      <span fg={theme.textFaint}>{(last ? glyph.treeEnd : glyph.treeMid) + glyph.treeBar + " "}</span>
    </span>
  );
}
