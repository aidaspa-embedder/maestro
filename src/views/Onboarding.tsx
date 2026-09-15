import { useCallback, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Shell } from "../components/Chrome.tsx";
import { ConfigEditor } from "../components/ConfigEditor.tsx";
import { Intro } from "./onboarding/Intro.tsx";
import { useApp } from "../state/app-context.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { detectTools } from "../services/setup.ts";
import { issueProvider } from "../integrations/issues/index.ts";
import { resolveToken, verifyToken } from "../services/github.ts";
import { theme } from "../theme.ts";
import { truncate } from "../lib/text.ts";
import type { SettingsSection } from "../state/settings-fields.ts";

const STEPS = ["Welcome", "GitHub", "Issue source", "Your workspace", "Ready"];
export function Onboarding() {
  const app = useApp();
  const { width, height } = useTerminalDimensions();
  const [intro, setIntro] = useState(true);
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  const tools = useAsync(detectTools, []);
  const finishIntro = useCallback(() => setIntro(false), []);
  const reduced = app.config.reducedMotion || process.env.MAESTRO_REDUCED_MOTION === "1" || process.env.TERM === "dumb";
  async function next() {
    if (busy.current) return;
    busy.current = true; setChecking(true); setMessage("");
    try {
      if (step === 0) {
        const installed = tools.data ?? await detectTools();
        if (!installed.find(t => t.name === "git")?.path) throw new Error("Install Git before creating workspaces, then restart setup.");
        if (!app.config.onboardingComplete && !installed.find(t => t.name === app.config.defaultAgent)?.path) {
          const agent = installed.find(t => t.name === "claude" && t.path) ? "claude" : installed.find(t => t.name === "codex" && t.path) ? "codex" : "shell";
          await app.patchConfig({ defaultAgent: agent });
        }
      }
      if (step === 1) await verifyToken(await resolveToken(app.config));
      if (step === 2) {
        const provider = issueProvider(app.config);
        if (!provider.configured) throw new Error(`Add ${provider.label} credentials, or Ctrl+S to configure later.`);
        await provider.verify();
      }
      if (step === 4) {
        await app.patchConfig({ onboardingComplete: true });
        app.replace({ view: "workspaces" });
        app.showToast("Setup saved — n creates your first workspace", "success");
      } else setStep(s => s + 1);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { busy.current = false; setChecking(false); }
  }
  useKeyboard(key => {
    if (intro || editing || checking || key.defaultPrevented) return;
    if ((key.ctrl && key.name === "n") || (key.name === "return" && (step === 0 || step === 4))) { key.preventDefault(); void next(); }
    if (key.ctrl && key.name === "b" && step > 0) { key.preventDefault(); setMessage(""); setStep(s => s - 1); }
    if (key.ctrl && key.name === "s" && step > 0 && step < 4) { key.preventDefault(); setMessage(""); setStep(s => s + 1); }
    if (key.name === "escape") { key.preventDefault(); app.replace({ view: "workspaces" }); }
  });
  if (intro) return <Intro reduced={Boolean(reduced)} onDone={finishIntro} />;
  const section: SettingsSection | undefined = step === 1 ? "github" : step === 2 ? "issues" : step === 3 ? "workspace" : undefined;
  const compact = height < 26;
  const line = (text: string) => truncate(text, Math.max(10, width - 8));
  return <Shell crumbs={["setup", STEPS[step]!.toLowerCase()]} hints={editing ? [
    { key: "⏎", label: "save field" }, { key: "esc", label: "cancel edit" },
  ] : [
    { key: step === 0 || step === 4 ? "⏎" : "^n", label: checking ? "checking…" : step === 4 ? "open maestro" : "continue" },
    ...(step > 0 && step < 4 ? [{ key: "^s", label: "configure later" }] : []),
    ...(step > 0 ? [{ key: "^b", label: "back" }] : []), { key: "esc", label: "later" },
  ]}>
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text height={1} flexShrink={0} fg={theme.accentBright}>{`${step + 1} / ${STEPS.length}   ${STEPS[step]!.toUpperCase()}`}</text>
      <box height={1} flexShrink={0} />
      {step === 0 ? <box flexDirection="column" flexGrow={1}>
        <text height={1} flexShrink={0} fg={theme.heading}>{"A workspace starts with an issue."}</text>
        <text height={1} flexShrink={0} fg={theme.textDim}>{line("Linear or Jira owns the issue. GitHub owns repositories and pull requests.")}</text>
        {!compact ? <text height={1} flexShrink={0} fg={theme.textDim}>{line("Maestro connects them through local worktrees and your coding agent.")}</text> : null}
        <box height={1} flexShrink={0} />
        <text height={1} flexShrink={0} fg={theme.textFaint}>{"DETECTED ON THIS MACHINE"}</text>
        {(tools.data ?? []).map(t => <text height={1} flexShrink={0} key={t.name} fg={t.path ? theme.success : theme.textDim}>{line(`${t.path ? "✓" : "○"} ${t.name.padEnd(8)} ${t.version ?? "not installed"}`)}</text>)}
        <box height={1} flexShrink={0} />
        {!compact ? <text height={1} flexShrink={0} fg={theme.textDim}>{line("Native session windows: macOS · Ghostty / iTerm2 / Terminal.app")}</text> : null}
        <text height={1} flexShrink={0} fg={theme.textFaint}>{line(compact ? "Setup saves as you go. Reopen: maestro --setup" : "Settings are saved as you go. Setup can be reopened with maestro --setup.")}</text>
      </box> : section ? <ConfigEditor key={section} config={app.config} section={section} onSave={app.patchConfig} onEditing={setEditing} reservedRows={9} /> :
        <box flexDirection="column" flexGrow={1}>
          <text height={1} flexShrink={0} fg={theme.heading}>{line("Your workspace is ready to configure and use.")}</text>
          <text height={1} flexShrink={0} fg={theme.textDim}>{line(`GitHub: ${app.github.status} · ${app.config.githubMode} authentication`)}</text>
          <text height={1} flexShrink={0} fg={theme.textDim}>{line(`${issueProvider(app.config).label}: ${app.issues.status}`)}</text>
          <text height={1} flexShrink={0} fg={theme.textDim}>{line(`Agent: ${app.config.defaultAgent} · Terminal: ${app.config.terminal}`)}</text>
          <box height={1} flexShrink={0} />
          <text height={1} flexShrink={0} fg={theme.warn}>{line("Claude always uses --dangerously-skip-permissions.")}</text>
          <text height={1} flexShrink={0} fg={theme.warn}>{line("Codex always uses --yolo. Both run without permission prompts.")}</text>
          <text height={1} flexShrink={0} fg={theme.textDim}>{line("Use trusted repositories and review agent changes before sharing.")}</text>
          <box height={1} flexShrink={0} />
          <text height={1} flexShrink={0} fg={theme.textDim}>{line("n  new workspace    s  settings    ?  keys")}</text>
          {!compact ? <text height={1} flexShrink={0} fg={theme.textFaint}>{line("Unlinked integrations can be completed in settings at any time.")}</text> : null}
        </box>}
      <text height={1} flexShrink={0} fg={message ? theme.danger : theme.textFaint}>{line(message || (checking ? "Checking connection…" : ""))}</text>
    </box>
  </Shell>;
}
