import { logger } from './logger';

/**
 * Markers that identify HTML produced by the in-editor diff preview
 * (react/utils/noteEditorDiffPreview.ts). If any appear in a string about to
 * be persisted via item.setNote(), saving must be refused — the diff HTML
 * is presentation-only and persisting it would corrupt the user's note.
 *
 * The rgba() forms are matched with tolerant whitespace because ProseMirror
 * round-trips styles through the DOM and browsers normalise rgba() with
 * spaces after commas.
 */
const PREVIEW_MARKERS: RegExp[] = [
    /id=["']beaver-preview-banner["']/i,
    /id=["']beaver-diff-preview-style["']/i,
    /rgba\(\s*210\s*,\s*40\s*,\s*40\s*,/,
    /rgba\(\s*16\s*,\s*150\s*,\s*72\s*,/,
];

export function containsPreviewMarkers(html: string): boolean {
    if (!html) return false;
    for (const marker of PREVIEW_MARKERS) {
        if (marker.test(html)) return true;
    }
    return false;
}

/**
 * Throw if `html` contains any diff-preview marker. Use at every setNote()
 * call site as a last-chance safety net against EditorInstance._disableSaving
 * being bypassed. Throws rather than strips so the surrounding rollback path
 * runs and the bug is surfaced in logs instead of silently corrupting the
 * note with garbled content.
 */
export function assertNoPreviewMarkers(html: string, context: string): void {
    if (!containsPreviewMarkers(html)) return;
    logger(`notePreviewGuard: refusing setNote at ${context} — diff preview markers detected`, 1);
    throw new Error(`Beaver: refusing to save note containing diff-preview markers (${context})`);
}
