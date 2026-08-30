/**
 * HTML primitives shared by the documents Beaver generates for Zotero's snapshot
 * reader (reports, tables). Deliberately free of Zotero APIs and of React so both
 * bundles and any future document builder can use them.
 */

/**
 * The reader counts top-level rules per author stylesheet and switches to a static
 * theme above 500. The static theme forces `background-color: transparent !important`
 * and a single text color onto every element, which flattens a designed palette.
 * Generated documents stay under the threshold so the nicer dynamic path is used.
 */
export const CSS_RULE_BUDGET = 500;

const ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** Escapes text for HTML body/attribute context. All model-authored text goes through this. */
export function escapeHtml(value: string): string {
    return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/** Counts top-level rules the way the reader does (nested at-rule bodies are not counted). */
export function countTopLevelCssRules(css: string): number {
    let depth = 0;
    let count = 0;
    for (const ch of css) {
        if (ch === '{') {
            if (depth === 0) count++;
            depth++;
        } else if (ch === '}') {
            depth = Math.max(0, depth - 1);
        }
    }
    return count;
}
