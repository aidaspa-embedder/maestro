import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { EmptyState, Spinner } from "../../components/primitives.tsx";
import { useAsync } from "../../hooks/useAsync.ts";
import { searchInputBindings } from "../../lib/keybindings.ts";
import type { Team } from "../../services/linear.ts";
import { linearProvider, type IssueProvider } from "../../integrations/issues/index.ts";
import type { IssueTicket } from "../../state/types.ts";
import { attrs, glyph, theme, transparent } from "../../theme.ts";

const LABEL_W = 13;

type Row = "title" | "description" | "team";
const ROWS: Row[] = ["title", "description", "team"];

/**
 * Quick ticket creation inside the new-workspace flow: title, description,
 * team — ⏎ creates the issue in Linear, self-assigned, and hands the full
 * ticket (with Linear's suggested branch name) straight back to the flow, so
 * the workspace is built from the ticket that didn't exist a second ago.
 */
export function TicketForm({
  apiKey,
  provider: suppliedProvider,
  onCreated,
  onCancel,
  onError,
}: {
  apiKey?: string;
  provider?: IssueProvider;
  onCreated: (ticket: IssueTicket) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const provider = suppliedProvider ?? linearProvider(apiKey);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [row, setRow] = useState<Row>("title");
  const [teamIndex, setTeamIndex] = useState(0);
  const [creating, setCreating] = useState(false);

  const { data, loading, error } = useAsync(() => provider.fetchTeams(), [apiKey, suppliedProvider]);
  const teams: Team[] = data?.teams ?? [];
  const team = teams[Math.min(teamIndex, Math.max(0, teams.length - 1))];

  async function submit() {
    if (creating) return;
    if (!title.trim()) {
      onError("Give the ticket a title first");
      return;
    }
    if (!team) {
      onError(`No ${provider.label} team/project to create the ticket in`);
      return;
    }
    setCreating(true);
    try {
      const ticket = await provider.createIssue({
        teamId: team.id,
        title: title.trim(),
        description: description.trim() || undefined,
        assigneeId: data?.viewerId,
      });
      onCreated(ticket);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  useKeyboard((key) => {
    if (creating) return;
    const claim = () => key.preventDefault();

    if (key.name === "escape") {
      claim();
      onCancel();
      return;
    }
    if (key.name === "return") {
      claim();
      void submit();
      return;
    }
    if (key.name === "up" || (key.name === "tab" && key.shift)) {
      claim();
      setRow((r) => ROWS[(ROWS.indexOf(r) - 1 + ROWS.length) % ROWS.length]!);
      return;
    }
    if (key.name === "down" || key.name === "tab") {
      claim();
      setRow((r) => ROWS[(ROWS.indexOf(r) + 1) % ROWS.length]!);
      return;
    }
    // ←→ cycle the team only on its own row, so they stay text-cursor keys
    // while a text field is focused.
    if (row === "team" && teams.length > 0 && (key.name === "left" || key.name === "right")) {
      claim();
      const dir = key.name === "left" ? -1 : 1;
      setTeamIndex((i) => (i + dir + teams.length) % teams.length);
    }
  });

  if (error) {
    return (
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
        <EmptyState title={error} hint={`Check ${provider.label} credentials in settings`} />
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={theme.textFaint} attributes={attrs.bold}>{"NEW TICKET"}</text>
      <box height={1} />

      <FormRow label="Title" active={row === "title"}>
        <input
          focused={row === "title" && !creating}
          value={title}
          onInput={setTitle}
          keyBindings={searchInputBindings}
          flexGrow={1}
          backgroundColor={transparent}
          focusedBackgroundColor={transparent}
          textColor={theme.white}
          cursorColor={theme.accent}
          placeholderColor={theme.textFaint}
          placeholder="what needs doing"
        />
      </FormRow>

      <FormRow label="Description" active={row === "description"}>
        <input
          focused={row === "description" && !creating}
          value={description}
          onInput={setDescription}
          keyBindings={searchInputBindings}
          flexGrow={1}
          backgroundColor={transparent}
          focusedBackgroundColor={transparent}
          textColor={theme.text}
          cursorColor={theme.accent}
          placeholderColor={theme.textFaint}
          placeholder="optional context"
        />
      </FormRow>

      <FormRow label={provider.kind === "jira" ? "Project" : "Team"} active={row === "team"}>
        {loading ? (
          <text>
            <Spinner />
            <span fg={theme.textFaint}>{" loading teams…"}</span>
          </text>
        ) : team ? (
          <text>
            <span fg={row === "team" ? theme.white : theme.text}>{`${team.name}`}</span>
            <span fg={theme.textFaint}>{`  ${team.key}`}</span>
            {teams.length > 1 && row === "team" ? (
              <span fg={theme.textFaint}>{`   ←→ ${teamIndex + 1}/${teams.length}`}</span>
            ) : null}
          </text>
        ) : (
          <text fg={theme.danger}>{"no teams visible to this key"}</text>
        )}
      </FormRow>

      <box paddingTop={1}>
        {creating ? (
          <text>
            <Spinner />
            <span fg={theme.textDim}>{` Creating the ticket in ${provider.label}…`}</span>
          </text>
        ) : (
          <text fg={theme.textFaint}>
            {"⏎ creates the ticket, assigns it to you, and moves on to repo selection."}
          </text>
        )}
      </box>
    </box>
  );
}

function FormRow({ label, active, children }: { label: string; active: boolean; children: React.ReactNode }) {
  return (
    <box flexDirection="row" height={1}>
      <text>
        <span fg={theme.accent}>{active ? glyph.box : " "}</span>
        <span fg={active ? theme.heading : theme.textDim}>{" " + label.padEnd(LABEL_W)}</span>
      </text>
      {children}
    </box>
  );
}
