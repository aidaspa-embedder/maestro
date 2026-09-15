const MAX_TITLE_CHARS = 48;

/** "Fix billing/webhook retries!" -> "fix-billing-webhook-retries" */
export function slugifyTitle(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accent marks left by NFKD
    .toLowerCase()
    .replace(/['’`]/g, "") // don't leave a dash where an apostrophe was
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (s.length <= MAX_TITLE_CHARS) return s;
  // Truncate on a word boundary so the slug stays readable.
  return s.slice(0, MAX_TITLE_CHARS).replace(/-[^-]*$/, "").replace(/-+$/, "");
}

/**
 * Worktree directory name: ENG-412-fix-billing-webhook-retries
 * Identifier keeps Linear's casing; the title is lowercased and dashed.
 */
export function workspaceSlug(identifier: string, title: string): string {
  const t = slugifyTitle(title);
  return t ? `${identifier}-${t}` : identifier;
}
