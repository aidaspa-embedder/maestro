import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { EmptyState, Spinner } from "../../components/primitives.tsx";
import { useAsync } from "../../hooks/useAsync.ts";
import { useListNav } from "../../hooks/useListNav.ts";
import { searchInputBindings } from "../../lib/keybindings.ts";
import { contract } from "../../lib/paths.ts";
import { fuzzyMatch, pad, truncate } from "../../lib/text.ts";
import { fetchBranches, fetchRepos, type GitHubRepo } from "../../services/github.ts";
import { glyph, theme, transparent } from "../../theme.ts";

const NAME_W = 26;
const CHROME_ROWS = 14;

const startingBranch = (repo: GitHubRepo) => repo.startingBranch ?? repo.defaultBranch;

/** A repo chosen for the workspace, with the branch its worktree branches from. */
export interface PickedRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  /** Branch the worktree is created from — main when present, else defaultBranch */
  baseBranch: string;
  isMain: boolean;
}

export interface RepoSelection {
  repos: PickedRepo[];
}

/**
 * Repos come from GitHub (everything the token can see, latest-pushed first),
 * not from a local directory scan — a repo needs no checkout on this machine
 * to be part of a workspace; maestro clones it itself when the worktrees are
 * created. `→` opens a branch list to change what a repo's worktree branches
 * from.
 */
export function RepoPicker({
  token,
  slug,
  worktreeRoot,
  onDone,
  onBack,
  onError,
  onBranchMode,
  width,
  cacheTtlMinutes,
  owner,
  exclude = [],
  preserveMain = false,
}: {
  /** GitHub token; without one the picker can only explain how to link */
  token: string | undefined;
  slug: string;
  worktreeRoot: string;
  onDone: (selection: RepoSelection) => void;
  onBack: () => void;
  onError: (message: string) => void;
  /** Reported up so the shell can swap footer hints while picking a branch */
  onBranchMode?: (repoName: string | null) => void;
  /** Column width — the picker shares the row with the ticket panel. */
  width: number;
  cacheTtlMinutes?: number;
  owner?: string;
  exclude?: string[];
  preserveMain?: boolean;
}) {
  const { height } = useTerminalDimensions();
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]); // nameWithOwner, in pick order
  const [mainKey, setMainKey] = useState<string | null>(null);
  /** nameWithOwner -> base branch, only when changed by the user */
  const [bases, setBases] = useState<Record<string, string>>({});
  const [branchRepo, setBranchRepo] = useState<GitHubRepo | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const branchFocusPending = useRef(false);

  const [cacheStatus, setCacheStatus] = useState("");
  const forceRefresh = useRef(false);
  const { data, loading, error, reload } = useAsync<GitHubRepo[]>(
    () => {
      const force = forceRefresh.current; forceRefresh.current = false;
      return fetchRepos(token!, { ttlMinutes: cacheTtlMinutes, force, onStatus: setCacheStatus });
    },
    [token, cacheTtlMinutes],
    { enabled: Boolean(token) },
  );

  const all = useMemo(() => (data ?? []).filter(r => (!owner || r.owner.toLowerCase() === owner.toLowerCase()) && !exclude.some(k => k.toLowerCase() === r.nameWithOwner.toLowerCase())), [data, owner, exclude.join("|")]);
  const visible = useMemo(
    () => (filter ? all.filter((r) => fuzzyMatch(filter, r.nameWithOwner)) : all),
    [all, filter],
  );

  const branches = useAsync<string[]>(
    () => fetchBranches(token!, branchRepo!.owner, branchRepo!.name),
    [branchRepo?.nameWithOwner, token],
    { enabled: Boolean(token && branchRepo) },
  );
  const visibleBranches = useMemo(() => {
    const list = branches.data ? [...branches.data] : [];
    if (branches.data && branchRepo) {
      const selected = bases[branchRepo.nameWithOwner] ?? startingBranch(branchRepo);
      if (!list.includes(selected)) list.unshift(selected);
    }
    return branchFilter ? list.filter((b) => fuzzyMatch(branchFilter, b)) : list;
  }, [branches.data, branchFilter, branchRepo, bases]);

  const viewport = Math.max(1, height - CHROME_ROWS);
  // No vim keys: j/k must stay typeable in the filter.
  const nav = useListNav(visible.length, viewport, { vimKeys: false });
  const branchNav = useListNav(visibleBranches.length, viewport, { vimKeys: false });
  const current = visible[nav.index];

  useEffect(() => {
    if (!branchFocusPending.current || !branchRepo || branches.loading || !branches.data) return;
    branchFocusPending.current = false;
    branchNav.setIndex(Math.max(0, visibleBranches.indexOf(bases[branchRepo.nameWithOwner] ?? startingBranch(branchRepo))));
  }, [branchRepo, branches.loading, branches.data, visibleBranches, bases, branchNav.setIndex]);

  function setBranchMode(repo: GitHubRepo | null) {
    branchFocusPending.current = Boolean(repo);
    setBranchRepo(repo);
    setBranchFilter("");
    onBranchMode?.(repo ? repo.name : null);
  }

  function toggle(repo: GitHubRepo) {
    setPicked((prev) => {
      if (prev.includes(repo.nameWithOwner)) {
        const next = prev.filter((k) => k !== repo.nameWithOwner);
        // Dropping the main repo hands the badge to whatever is still selected.
        if (mainKey === repo.nameWithOwner) setMainKey(next[0] ?? null);
        return next;
      }
      if (mainKey === null) setMainKey(repo.nameWithOwner);
      return [...prev, repo.nameWithOwner];
    });
  }

  function pickBranch(branch: string) {
    if (!branchRepo) return;
    const key = branchRepo.nameWithOwner;
    setBases((prev) => {
      const next = { ...prev };
      // Only keep explicit changes from the initial starting branch.
      if (branch === startingBranch(branchRepo)) delete next[key];
      else next[key] = branch;
      return next;
    });
    // Choosing a base for an unselected repo means you want it in the workspace.
    if (!picked.includes(key)) toggle(branchRepo);
    setBranchMode(null);
  }

  useKeyboard((key) => {
    // Global handlers run before renderables, so claiming a key here is what
    // stops the focused filter input from also swallowing it as text. Only
    // non-printable keys are claimed, keeping the filter fully typeable.
    const claim = () => key.preventDefault();

    if (key.ctrl && key.name === "r") {
      claim();
      if (branchRepo) branches.reload();
      else { forceRefresh.current = true; reload(); }
      return;
    }

    if (branchRepo) {
      if (key.name === "escape" || key.name === "left") {
        claim();
        setBranchMode(null);
        return;
      }
      if (key.name === "return") {
        claim();
        const branch = !branches.loading && !branches.error ? visibleBranches[branchNav.getIndex()] : undefined;
        if (branch) pickBranch(branch);
        return;
      }
      if (branchNav.handleKey(key)) claim();
      return;
    }

    // Read the live index — an arrow and a space can arrive in the same tick.
    const row = visible[nav.getIndex()];

    if (key.name === "escape") {
      claim();
      onBack();
      return;
    }
    if (key.name === "space") {
      claim();
      if (row) toggle(row);
      return;
    }
    if (key.name === "tab") {
      claim();
      if (preserveMain) { onError("The existing workspace keeps its main repository"); return; }
      if (row && picked.includes(row.nameWithOwner)) setMainKey(row.nameWithOwner);
      else if (row) onError(`Select ${row.name} first (space), then tab`);
      return;
    }
    if (key.name === "right") {
      claim();
      if (row) setBranchMode(row);
      return;
    }
    if (key.name === "a" && key.ctrl) {
      claim();
      setPicked(visible.map((r) => r.nameWithOwner));
      if (!visible.some(r => r.nameWithOwner === mainKey)) setMainKey(visible[0]?.nameWithOwner ?? null);
      return;
    }
    if (key.name === "return") {
      claim();
      if (picked.length === 0) {
        onError("Pick at least one repo with space");
        return;
      }
      const main = mainKey && picked.includes(mainKey) ? mainKey : picked[0]!;
      const repos = picked
        .map((k) => all.find((r) => r.nameWithOwner === k))
        .filter((r): r is GitHubRepo => Boolean(r))
        .map((r) => ({
          owner: r.owner,
          name: r.name,
          defaultBranch: r.defaultBranch,
          baseBranch: bases[r.nameWithOwner] ?? startingBranch(r),
          isMain: !preserveMain && r.nameWithOwner === main,
        }));
      onDone({ repos });
      return;
    }
    if (nav.handleKey(key)) claim();
  });

  if (!token) {
    return (
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
        <EmptyState title="GitHub is not linked" hint="Press esc, then s — log in with gh or paste a token" />
      </box>
    );
  }

  if (branchRepo) {
    return (
      <BranchList
        repo={branchRepo}
        filter={branchFilter}
        setFilter={setBranchFilter}
        branches={visibleBranches}
        loading={branches.loading}
        error={branches.error}
        nav={branchNav}
        viewport={viewport}
        width={width}
        base={bases[branchRepo.nameWithOwner] ?? startingBranch(branchRepo)}
      />
    );
  }

  const pathW = Math.max(12, width - 4 - 2 - 4 - NAME_W - 8 - 14);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={1} paddingTop={1}>
      <box flexDirection="row" height={1}>
        <text>
          <span fg={theme.accent}>{glyph.chevron + " "}</span>
        </text>
        <input
          focused
          value={filter}
          onInput={setFilter}
          keyBindings={searchInputBindings}
          flexGrow={1}
          backgroundColor={transparent}
          focusedBackgroundColor={transparent}
          textColor={theme.heading}
          cursorColor={theme.accent}
          placeholderColor={theme.textFaint}
          placeholder="filter repos"
        />
        {loading ? (
          <text>
            <Spinner />
          </text>
        ) : (
          <text fg={theme.textFaint}>{`${picked.length} selected${cacheStatus ? ` · ${cacheStatus}` : ""}`}</text>
        )}
      </box>

      <box height={1} />

      {error ? (
        <EmptyState title={error} hint="Check GitHub access in settings, then come back" />
      ) : visible.length === 0 && !loading ? (
        <EmptyState
          title={all.length === 0 ? "No repos visible to this GitHub account" : `Nothing matching "${filter}"`}
        />
      ) : (
        <box flexDirection="column">
          {visible.slice(nav.start, nav.start + viewport).map((repo, i) => {
            const selected = nav.start + i === nav.index;
            const on = picked.includes(repo.nameWithOwner);
            const isMain = !preserveMain && mainKey === repo.nameWithOwner;
            const base = bases[repo.nameWithOwner];
            return (
              <box
                key={repo.nameWithOwner}
                flexDirection="row"
                height={1}
                backgroundColor={selected ? theme.selBg : undefined}
              >
                <text>
                  <span fg={theme.accent}>{selected ? glyph.box : " "}</span>
                  <span>{" "}</span>
                  <span fg={on ? theme.success : theme.textFaint}>{on ? glyph.check : glyph.dotOpen}</span>
                  <span>{" "}</span>
                  <span fg={on ? theme.heading : selected ? theme.text : theme.textDim}>
                    {pad(truncate(repo.name, NAME_W - 1), NAME_W)}
                  </span>
                  <span fg={theme.purple}>{pad(isMain ? "main" : "", 6)}</span>
                  <span fg={theme.textFaint}>{pad(truncate(repo.nameWithOwner, pathW - 1), pathW)}</span>
                  <span fg={base ? theme.cyan : theme.textFaint}>
                    {truncate(base ? `${glyph.branch} ${base}` : "", 14)}
                  </span>
                </text>
              </box>
            );
          })}
        </box>
      )}

      <box flexGrow={1} />

      {current ? (
        <box flexDirection="column" paddingTop={1}>
          <text height={1} flexShrink={0}>
            <span fg={theme.textDim}>{"Starting branch  "}</span>
            <span fg={theme.accent}>{truncate(bases[current.nameWithOwner] ?? startingBranch(current), Math.max(4, width - 21))}</span>
          </text>
          <text height={1} flexShrink={0} fg={theme.textFaint}>{"→ change starting branch"}</text>
          <text height={1} flexShrink={0} fg={theme.textFaint}>{"WORKTREE"}</text>
          <text height={1} flexShrink={0} fg={theme.textDim}>
            {truncate(
              `${contract(worktreeRoot)}/${current.owner}/${current.name}/${slug}`,
              Math.max(10, width - 4),
            )}
          </text>
        </box>
      ) : null}
    </box>
  );
}

/** The base-branch list for one repo. Same filter-plus-list shape as the picker. */
function BranchList({
  repo,
  filter,
  setFilter,
  branches,
  loading,
  error,
  nav,
  viewport,
  width,
  base,
}: {
  repo: GitHubRepo;
  filter: string;
  setFilter: (v: string) => void;
  branches: string[];
  loading: boolean;
  error: string | undefined;
  nav: { start: number; index: number };
  viewport: number;
  width: number;
  base: string;
}) {
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={1} paddingTop={1}>
      <text height={1} flexShrink={0} fg={theme.heading}>{truncate(`Starting branch · ${repo.name}`, Math.max(10, width - 4))}</text>
      <box flexDirection="row" height={1}>
        <text>
          <span fg={theme.accent}>{glyph.chevron + " "}</span>
        </text>
        <input
          focused
          value={filter}
          onInput={setFilter}
          keyBindings={searchInputBindings}
          flexGrow={1}
          backgroundColor={transparent}
          focusedBackgroundColor={transparent}
          textColor={theme.heading}
          cursorColor={theme.accent}
          placeholderColor={theme.textFaint}
          placeholder="filter branches"
        />
        {loading ? (
          <text>
            <Spinner />
          </text>
        ) : (
          <text fg={theme.textFaint}>{`${branches.length}`}</text>
        )}
      </box>

      <box height={1} />

      {error ? (
        <EmptyState title={error} hint="esc goes back to the repo list" />
      ) : branches.length === 0 && !loading ? (
        <EmptyState title={filter ? `No branches matching "${filter}"` : "No branches found"} />
      ) : (
        <box flexDirection="column">
          {branches.slice(nav.start, nav.start + viewport).map((branch, i) => {
            const selected = nav.start + i === nav.index;
            const isDefault = branch === repo.defaultBranch;
            const isBase = branch === base;
            return (
              <box key={branch} flexDirection="row" height={1} backgroundColor={selected ? theme.selBg : undefined}>
                <text>
                  <span fg={theme.accent}>{selected ? glyph.box : " "}</span>
                  <span>{" "}</span>
                  <span fg={isBase ? theme.success : theme.textFaint}>{isBase ? glyph.check : glyph.dotOpen}</span>
                  <span>{" "}</span>
                  <span fg={selected ? theme.heading : theme.text}>
                    {pad(truncate(branch, Math.max(12, width - 24)), Math.max(13, width - 23))}
                  </span>
                  <span fg={theme.textFaint}>{isDefault ? "default" : ""}</span>
                </text>
              </box>
            );
          })}
        </box>
      )}

      <box flexGrow={1} />
    </box>
  );
}
