/**
 * Reason codes of the paragraph detector's line decision (`startNewItem`):
 * which rule decided, which break signals were on and which vetoes cleared
 * one. The item-boundary features read them as the heuristic's decision.
 */

/**
 * The rule that decided `startNewItem`, in the order the rules run. `none`
 * and `heading_continues` keep the line in the current item; every other rule
 * starts a new one. The index of a rule is its code in the boundary features.
 *
 *   - `forced`: the block's first line.
 *   - `numbered`: the next number of a numbered list (`isNextNumberedEntry`).
 *   - `heading_after_body`: a heading line after a non-heading line.
 *   - `heading_style_change`: a heading line after a heading line in another style.
 *   - `heading_stacked`: two same-style headings a paragraph gap apart (`stackedHeadingGap`).
 *   - `heading_continues`: a heading line continuing a same-style heading.
 *   - `heading_opening_style`: a line opening in another style after a heading.
 *   - `heading_ends_before_body`: a body line ending a heading (`headingEndsBeforeBodyLine`).
 *   - `gap`, `indent`, `early_end`, `font_size`, `leader_after_continuation`,
 *     `hanging_entry`: the visual break signals, the first one on deciding.
 */
export const START_RULES = [
    "none",
    "forced",
    "numbered",
    "heading_after_body",
    "heading_style_change",
    "heading_stacked",
    "heading_continues",
    "heading_opening_style",
    "heading_ends_before_body",
    "gap",
    "indent",
    "early_end",
    "font_size",
    "leader_after_continuation",
    "hanging_entry",
] as const;

export type StartRule = (typeof START_RULES)[number];

/** Visual break signals still on when `startNewItem` combined them (`StartTrace.signals`). */
export const START_SIGNALS = {
    gap: 1,
    indent: 2,
    early_end: 4,
    font_size: 8,
    leader_after_continuation: 16,
    hanging_entry: 32,
} as const;

/** Vetoes that cleared a break signal (`StartTrace.vetoes`). */
export const START_VETOES = {
    /** A wrapped line of a leader-led item: the gap is cleared. */
    leader_continuation: 1,
    /** The gap matches the leading established inside the item. */
    uniform_leading: 2,
    /** A leader's hanging continuation: the indent is cleared. */
    indent_suppression: 4,
    /** The previous line's superscript marker: the font-size break is cleared. */
    superscript_marker: 8,
    /** The line wraps around a drop cap: indent, early end and font size are cleared. */
    drop_cap: 16,
    /** A same-indent continuation of a leader-led item: gap, early end and font size are cleared. */
    same_indent_hanging: 32,
    /** A hanging-block continuation: indent and early end are cleared. */
    hanging_continuation: 64,
} as const;

/** Why `startNewItem` decided as it did (filled when a trace is passed). */
export interface StartTrace {
    rule: StartRule;
    /** `START_SIGNALS` bits still on when the signals were combined. */
    signals: number;
    /** `START_VETOES` bits of the vetoes that cleared a signal. */
    vetoes: number;
}
