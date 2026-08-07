/**
 * Risk classification for whole-note rewrites.
 *
 * `operation: "rewrite"` replaces a note's entire body, so whatever the payload
 * omits is gone. Most rewrites are benign — the model reproduces the note and
 * folds its changes in — but a rewrite that drops or replaces most of the note
 * is the one agent action that can destroy a user's work in a single approval.
 * Validation classifies those so they always ask, even for users who set note
 * edits to apply automatically.
 *
 * Two independent signals, because either alone misses a real case:
 * - Shrinkage catches a rewrite that carries only a section of the note.
 * - Retention catches a rewrite that keeps the length but replaces the content.
 *
 * Retention is measured with character trigrams rather than words: it needs no
 * tokenizer, so it behaves the same for scripts that do not separate words with
 * spaces. Both signals run over plain text, so pure markup changes do not
 * register as content loss.
 */

export interface NoteRewriteRisk {
    /** Share of the note's text the rewrite drops, 0–1 (negative when it grows). */
    removedFraction: number;
    /** Share of the note's original text fragments that survive, 0–1. */
    retainedFraction: number;
    /** Which signal fired: the note shrank, or its content was swapped out. */
    reason: 'shrunk' | 'replaced' | null;
    isDestructive: boolean;
}

/** Notes below this length are cheap to redo, so rewriting one never escalates. */
const MIN_CHARS_TO_ESCALATE = 600;
/** Escalate when the rewrite drops at least this share of the note's text. */
const MAX_REMOVED_FRACTION = 0.25;
/** Escalate when less than this share of the note's original text survives. */
const MIN_RETAINED_FRACTION = 0.6;
const SHINGLE_SIZE = 3;

/**
 * Reduce note HTML to comparable plain text: drop tags, collapse whitespace,
 * lowercase. Crude by design — this feeds a similarity ratio, not a renderer.
 */
export function toComparableText(html: string): string {
    return html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&[a-z]+;|&#\d+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function shingleCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (let i = 0; i + SHINGLE_SIZE <= text.length; i++) {
        const key = text.substr(i, SHINGLE_SIZE);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

/**
 * Share of `oldText`'s trigrams that also occur in `newText`, counting
 * multiplicity. 1 means everything survived; 0 means nothing did.
 */
export function retainedFraction(oldText: string, newText: string): number {
    const oldCounts = shingleCounts(oldText);
    const newCounts = shingleCounts(newText);

    let total = 0;
    let overlap = 0;
    for (const [shingle, count] of oldCounts) {
        total += count;
        overlap += Math.min(count, newCounts.get(shingle) ?? 0);
    }
    return total > 0 ? overlap / total : 1;
}

/**
 * Classify a whole-note rewrite against the note it would replace.
 *
 * @param currentHtml Simplified HTML of the note as it stands now.
 * @param newHtml The rewrite's replacement body.
 */
export function assessNoteRewrite(currentHtml: string, newHtml: string): NoteRewriteRisk {
    const oldText = toComparableText(currentHtml);
    const newText = toComparableText(newHtml);

    const removedFraction = oldText.length > 0
        ? (oldText.length - newText.length) / oldText.length
        : 0;
    const retained = retainedFraction(oldText, newText);

    const worthProtecting = oldText.length >= MIN_CHARS_TO_ESCALATE;
    let reason: NoteRewriteRisk['reason'] = null;
    if (worthProtecting) {
        if (removedFraction >= MAX_REMOVED_FRACTION) reason = 'shrunk';
        else if (retained < MIN_RETAINED_FRACTION) reason = 'replaced';
    }

    return {
        removedFraction,
        retainedFraction: retained,
        reason,
        isDestructive: reason !== null,
    };
}
