import { defaultTextareaKeyBindings } from "@opentui/core";

const PASS_THROUGH = new Set(["up", "down", "pageup", "pagedown", "home", "end"]);

/**
 * Input keybindings with unmodified up/down/page/home/end removed, so a search
 * box can stay focused while those keys drive the result list underneath it.
 * Modified variants (super+up = buffer-home) are left alone.
 */
export const searchInputBindings = defaultTextareaKeyBindings.filter(
  (b) => !(PASS_THROUGH.has(b.name) && !b.ctrl && !b.meta && !b.super && !b.shift),
);
