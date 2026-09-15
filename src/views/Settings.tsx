import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { Shell } from "../components/Chrome.tsx";
import { ConfigEditor } from "../components/ConfigEditor.tsx";
import { clearRepositoryCache } from "../services/repository-cache.ts";
import { useApp } from "../state/app-context.tsx";
import { theme } from "../theme.ts";

export function Settings() {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  useKeyboard(key => {
    if (editing || key.defaultPrevented) return;
    if (key.name === "escape" || key.name === "q") app.back();
    if (key.name === "r") { app.checkConnections(); app.showToast("Rechecking connections…"); }
    if (key.name === "o") app.navigate({ view: "onboarding" });
    if (key.name === "c") void clearRepositoryCache().then(() => app.showToast("Repository cache cleared", "success"), () => app.showToast("Could not clear cache", "error"));
  });
  return <Shell crumbs={["settings"]} hints={editing ? [{ key: "⏎", label: "save" }, { key: "esc", label: "cancel" }] : [
    { key: "↑↓", label: "move" }, { key: "⏎", label: "edit" }, { key: "r", label: "recheck" }, { key: "c", label: "clear cache" }, { key: "o", label: "setup" }, { key: "esc", label: "back" },
  ]}>
    <box flexDirection="column" padding={2} flexGrow={1}>
      <ConfigEditor config={app.config} onSave={app.patchConfig} onEditing={setEditing} reservedRows={10} />
      <text fg={theme.danger}>{app.issues.error ?? app.github.error ?? ""}</text>
    </box>
  </Shell>;
}
