import {
    resolveAnchoredTextRange,
    type AnchoredTextLocator,
} from "../../../src/services/documentExtraction/dom/textRange";

/** Locator for a snapshot citation: a DOM anchor id and/or the cited text. */
export type SnapshotCitationTarget = AnchoredTextLocator;

/**
 * Resolve a cited passage to a live DOM range inside the snapshot reader body.
 * Searches the anchor element first (when given), then the whole body, and
 * finally falls back to the anchor element's full contents — so an anchor-only
 * citation (anchor id, no cited text) still resolves to a range, matching the
 * headless annotation resolver. Matching is whitespace-normalized, so the range
 * survives inline markup splitting the sentence. Returns null when nothing
 * matches.
 */
export function resolveSnapshotCitationRange(
    body: HTMLElement,
    target: SnapshotCitationTarget,
): Range | null {
    return resolveAnchoredTextRange(body, target) ?? null;
}
