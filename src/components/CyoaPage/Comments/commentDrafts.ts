// Comment draft autosave in sessionStorage: survives form unmount (thread reload) and real page
// reloads — mobile Safari unloads background tabs and reloads on return; people lost long replies.
// Keys per form: `new.<gameId>`, `reply.<commentId>`, `edit.<commentId>`. All storage access
// wrapped: private mode / quota throws and a lost draft must not break input.

const DRAFT_PREFIX = 'cyoa.comment-draft.';

export function readDraft(key: string | undefined): string | null {
  if (!key) return null;
  try {
    const v = sessionStorage.getItem(DRAFT_PREFIX + key);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function hasCommentDraft(key: string | undefined): boolean {
  return readDraft(key) !== null;
}

export function clearCommentDraft(key: string | undefined): void {
  if (!key) return;
  try {
    sessionStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
  }
}

// A draft equal to the initial text (unchanged edit) isn't stored, or the edit form would reopen
// itself after every reload.
export function writeDraft(key: string | undefined, value: string, initialValue: string): void {
  if (!key) return;
  if (!value.trim() || value === initialValue) {
    clearCommentDraft(key);
    return;
  }
  try {
    sessionStorage.setItem(DRAFT_PREFIX + key, value);
  } catch {
  }
}
