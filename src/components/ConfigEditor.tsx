import { useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { settingsFields, type SettingsSection } from "../state/settings-fields.ts";
import type { Config } from "../state/types.ts";
import { contract } from "../lib/paths.ts";
import { truncate } from "../lib/text.ts";
import { theme, glyph, transparent } from "../theme.ts";
import { SecretInput } from "./SecretInput.tsx";
import { searchInputBindings } from "../lib/keybindings.ts";

export function ConfigEditor({ config, section, onSave, onEditing, reservedRows = 8 }: {
  config: Config; section?: SettingsSection; onSave: (patch: Partial<Config>) => Promise<void>;
  onEditing?: (editing: boolean) => void; reservedRows?: number;
}) {
  const { height, width } = useTerminalDimensions();
  const fields = settingsFields(config, section);
  const [index, setIndex] = useState(0);
  const liveIndex = useRef(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);
  const selected = Math.min(index, fields.length - 1);
  const field = fields[selected]!;
  const count = Math.max(1, Math.floor((height - reservedRows - 3) / 2));
  const start = Math.max(0, Math.min(selected - count + 1, fields.length - count));
  function edit(next: boolean) { setEditing(next); onEditing?.(next); setError(""); }
  async function save(value: unknown) {
    const field = fields[Math.min(liveIndex.current, fields.length - 1)]!;
    if (busy.current) return;
    busy.current = true;
    try { await onSave({ [field.id]: value }); edit(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busy.current = false; }
  }
  function cycle(dir: number) {
    const field = fields[Math.min(liveIndex.current, fields.length - 1)]!;
    const options = field.options!;
    const i = options.indexOf(config[field.id] as string | boolean | number);
    void save(options[(i + dir + options.length) % options.length]);
  }
  useKeyboard(key => {
    if (busy.current || key.defaultPrevented) return;
    const field = fields[Math.min(liveIndex.current, fields.length - 1)]!;
    if (editing) {
      if (key.name === "escape") { key.preventDefault(); edit(false); }
      if (key.name === "return") { key.preventDefault(); void save(draft.trim() || undefined); }
      return;
    }
    if (["up", "down", "tab"].includes(key.name) || (!key.ctrl && ["j", "k"].includes(key.name))) {
      key.preventDefault();
      const dir = key.name === "up" || key.name === "k" || key.shift ? -1 : 1;
      liveIndex.current = (Math.min(liveIndex.current, fields.length - 1) + dir + fields.length) % fields.length;
      setIndex(liveIndex.current);
    } else if ((key.name === "left" || key.name === "right" || key.name === "space") && field.kind === "cycle") {
      key.preventDefault(); cycle(key.name === "left" ? -1 : 1);
    } else if (key.name === "return") {
      key.preventDefault();
      if (field.kind === "cycle") cycle(1);
      else { setDraft(field.kind === "secret" ? "" : String(config[field.id] ?? "")); edit(true); }
    }
  });
  const labelW = Math.min(26, Math.floor(width * 0.4));
  function display(id: keyof Config, secret: boolean): string {
    const v = config[id];
    if (secret) return v ? "•••••••• (stored)" : "not set / environment";
    if (typeof v === "boolean") return v ? "on" : "off";
    return id === "worktreeRoot" ? contract(String(v)) : String(v ?? "default");
  }
  return <box flexDirection="column" flexGrow={1}>
    {fields.slice(start, start + count).map((f, i) => {
      const active = start + i === selected;
      return <box key={f.id} flexDirection="column" height={2} flexShrink={0}>
        <box flexDirection="row" height={1}>
          <text height={1} flexShrink={0} fg={active ? theme.heading : theme.textDim}>{`${active ? glyph.box : " "} ${truncate(f.label, labelW - 2).padEnd(labelW)} `}</text>
          {active && editing ? f.kind === "secret" ? <SecretInput value={draft} onChange={setDraft} /> :
            <input focused value={draft} onInput={setDraft} flexGrow={1} keyBindings={searchInputBindings}
              backgroundColor={transparent} focusedBackgroundColor={transparent} textColor={theme.heading} cursorColor={theme.accent} /> :
            <text height={1} flexShrink={0} fg={active ? theme.accentBright : theme.textDim}>{truncate(display(f.id, f.kind === "secret"), Math.max(5, width - labelW - 9))}</text>}
        </box>
      </box>;
    })}
    <box flexGrow={1} />
    <text height={1} flexShrink={0} fg={error ? theme.danger : theme.textFaint}>{truncate(error || (editing ? "Enter saves • Esc cancels • empty clears • Ctrl+U clears secret" : field.help), Math.max(10, width - 4))}</text>
    <text height={1} flexShrink={0} fg={theme.textFaint}>{`${selected + 1}/${fields.length}  ${editing ? "editing" : "↑↓ fields · Enter edit · ←→ change"}`}</text>
  </box>;
}
