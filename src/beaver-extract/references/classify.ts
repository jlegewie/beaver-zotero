/**
 * Reference classification for structured extraction.
 *
 * `planReferences` scores every item of a document (see `model.ts`) and
 * decides which items are reference-list entries, re-scoring items next to
 * entries once the list's own layout has repaired their segmentation. `applyReferencePlan` turns
 * one page's plan into edited draft items: `reference` items, split where one
 * item holds several entries, and merged where an entry was broken off its
 * continuation in the same column.
 */

import { mergeBoxes } from "@beaver/agent-core/extract/types";
import type { PageLine } from "../LineDetector";
import { joinLines, type HangingRole } from "../ParagraphDetector";
import type { DraftItem } from "../pipeline/draftItems";
import { lineStartProbability, scoreReferences, type ReferenceModel } from "./model";
import { HANGING_MAX_INDENT_EM, LINE_FEATURES, canOpenEntry, hangingLevels, pageLineFeatures } from "./lines";
import { hasBibliographicDetail, isNotesHeading, isReferenceHeading, proseWordCount } from "./features";
import type { RefItem, RefLine, RefPage } from "./pageInput";
import { REFERENCE_MODEL } from "./weights";

export interface ReferencePagePlan {
    /** Reference probability of each input item. */
    probs: number[];
    /** Whether each input item is a reference entry (or part of one). */
    reference: boolean[];
    /** Per input item: line indices (≥ 1) at which a new entry starts. */
    splits: number[][];
    /** Per input item: it continues the previous item's entry in the same column. */
    mergeWithPrevious: boolean[];
}

/**
 * Classify the items of a document. `pages` are its pages in order.
 *
 * Items scoring at or above the model threshold are reference entries,
 * except captions, table notes and appendix labels. Line plans then split and join them
 * (`planLines`), and items next to entries that the scores missed because
 * the list was cut badly are re-segmented and scored again
 * (`acceptCandidates`).
 */
export function planReferences(
    pages: readonly RefPage[],
    pageCount: number,
    model: ReferenceModel = REFERENCE_MODEL,
): ReferencePagePlan[] {
    const probs = scoreReferences(model, pages, pageCount);
    const reference = pages.map((page, p) =>
        page.items.map((item, i) => probs[p][i] >= model.threshold && !isNonEntryLabel(item.text)),
    );
    const candidates = referenceCandidates(pages, reference);
    const member = reference.map((refs, p) => refs.map((ref, i) => ref || candidates.candidate[p][i]));
    let lines = pages.map((page, p) => planLines(model, page, reference[p], reference[p], member[p]));
    if (candidates.candidate.some((c) => c.some(Boolean))) {
        // Line plans of the reference items and the candidates, each of which
        // can continue the previous one; only reference entries can establish
        // a column's layout.
        const scored = reference.map((refs) => refs.slice());
        const candidateLines = pages.map((page, p) => planLines(model, page, member[p], scored[p]));
        acceptCandidates(model, pages, pageCount, reference, candidates, candidateLines);
        // The returned plan cuts the final entries alone. A rejected candidate
        // can only keep the layout from deciding (see `hangingLevels`).
        lines = pages.map((page, p) =>
            reference[p].some((ref, i) => ref !== scored[p][i])
                ? planLines(model, page, reference[p], reference[p], member[p])
                : lines[p],
        );
    }
    return pages.map((page, p) => ({
        probs: probs[p],
        reference: reference[p],
        splits: page.items.map((_, i) => (reference[p][i] ? lines[p].splits[i] : [])),
        // Only a reference entry can be continued.
        mergeWithPrevious: page.items.map(
            (_, i) => reference[p][i] && lines[p].mergeWithPrevious[i] && reference[p][i - 1] === true,
        ),
    }));
}

/**
 * A caption or table note: "Table 1. Description of …", "Figure 2a.",
 * "Appendix Table A1:", "Note: …". It sits next to a table or figure, which
 * can follow a reference list without a heading between them, but it is
 * never a reference entry.
 */
const CAPTION_LABEL_RE =
    /^\s*(?:(?:appendix|online|supplementary|supplemental|supporting|extended\s+data)\s+)?(?:table|figure|fig\.?|exhibit|chart|scheme|plate|map|graph)\s*[A-Z]?\d{1,3}(?:\.\d{1,2})?[a-z]?\s*(?:[.:—–-]|\(cont|$|\s+\p{Lu})|^\s*(?:notes?|sources?)\s*:/iu;

export function isCaptionLabel(text: string): boolean {
    return CAPTION_LABEL_RE.test(text);
}

/**
 * The label of an appendix or annex: "Appendix A: Journal Coverage", "Online
 * Appendix B. Journal Sample", "Supplementary Appendix", "Appendices". A new
 * section can follow a reference list in body styling at the list's indent,
 * and its title can read like part of an entry ("… Journal Coverage"). A
 * source whose title starts with the word ("Appendix to the Journals of the
 * House of Representatives") is not a label.
 */
const APPENDIX_LABEL_RE =
    /^\s*(?:(?:online|supplementary|supplemental|web|technical|statistical)\s+)?(?:appendix|appendices|annex|annexes|annexe|anhang)(?:\s*[.:—–-]|\s*$|\s+(?:[A-Z]\d{0,2}|\d{1,2}|[IVX]{1,4})(?:\s*[.:—–-]|\s*$|\s+\p{Lu}))/iu;

/** Captions, table notes and appendix labels: text beside a list that is never one of its entries. */
export function isNonEntryLabel(text: string): boolean {
    return isCaptionLabel(text) || APPENDIX_LABEL_RE.test(text);
}

interface LinePlan {
    /** Per item: line indices (≥ 1) at which a new entry starts. */
    splits: number[][];
    /** Per item: its first line continues the previous member's entry in the same column. */
    mergeWithPrevious: boolean[];
    /**
     * Per item: its first line starts where a continuation of the previous
     * item's entry could, between that item's left edge and a hanging indent
     * in from it, and not at the outer edge of a hanging list, where entries
     * start. A page number or a centered line below an entry does not.
     */
    aligned: boolean[];
}

/**
 * Entry starts inside, and continuations across, the wanted items of a page.
 * `layout` are the items whose lines take part in reading a column's layout
 * and `votes` those that can establish it (`hangingLevels`). The line model
 * decides, and in a hanging list (`hangingLevels`) the layout
 * adds what it misses: a later line at the outer edge starts an entry unless
 * it runs on from the line before (`canOpenEntry`), and an item whose first
 * line sits at the inner edge continues the previous one unless the line
 * model is confident it starts one (a box set below the list can line up
 * with the inner edge).
 */
function planLines(
    model: ReferenceModel,
    page: RefPage,
    wanted: readonly boolean[],
    votes: readonly boolean[] = wanted,
    layout: readonly boolean[] = wanted,
): LinePlan {
    const splits: number[][] = page.items.map(() => []);
    const mergeWithPrevious = page.items.map(() => false);
    const em = page.bodySize > 0 ? page.bodySize : 10;
    const aligned = page.items.map((item, i) => {
        const previous = i > 0 ? page.items[i - 1] : null;
        if (!previous || previous.lines.length === 0 || item.lines.length === 0) return false;
        const edge = Math.min(...previous.lines.map((l) => l.l));
        const d = item.lines[0].l - edge;
        return d >= -0.5 * em && d <= HANGING_MAX_INDENT_EM * em;
    });
    const lineRows = pageLineFeatures(page, (i) => wanted[i]);
    const levels = hangingLevels(page, (i) => wanted[i] || layout[i], (i) => votes[i]);
    levels.forEach((level, i) => {
        if (level[0] === "outer") aligned[i] = false;
    });
    for (const [i, rows] of lineRows) {
        const level = levels.get(i);
        rows.forEach((x, k) => {
            const start = lineStartProbability(model, x);
            const layoutStart = level?.[k] === "outer" && canOpenEntry(page.items[i].lines[k].text);
            const layoutContinuation = level?.[k] === "inner" && aligned[i] && start < model.lines.splitThreshold;
            if (k > 0 && (start >= model.lines.splitThreshold || layoutStart)) splits[i].push(k);
            // Only a line after the previous item's last line in the same
            // column (`hasPrev`) can continue it.
            if (
                k === 0 &&
                i > 0 &&
                wanted[i - 1] &&
                x[LINE_HAS_PREV] === 1 &&
                (start < model.lines.mergeThreshold || layoutContinuation)
            ) {
                mergeWithPrevious[i] = true;
            }
        });
    }
    return { splits, mergeWithPrevious, aligned };
}

/** Non-reference items a candidate may sit among, in reading order. */
const CANDIDATE_REACH = 3;

/** Candidate items (`referenceCandidates`). */
interface Candidates {
    candidate: boolean[][];
    /** The candidate has reference entries on both sides; otherwise it follows the last one. */
    inside: boolean[][];
}

/**
 * Items that may be reference entries the item scores missed because the
 * paragraph detector cut the list badly: an item holding several one-line
 * entries, or the continuation lines of an entry broken off its first line,
 * reads differently from a whole entry. A candidate is a body item within
 * `CANDIDATE_REACH` non-reference items of a reference entry on both sides
 * in reading order (across page breaks), with no heading or label in
 * between, or the item right after a reference entry, which may continue it.
 * A heading or label is never one.
 */
function referenceCandidates(pages: readonly RefPage[], reference: readonly boolean[][]): Candidates {
    // A boundary ends a list: a heading, or a label read from the text — a
    // list heading, a caption or an appendix label set like body text.
    type Slot = { p: number; i: number; boundary: boolean; ref: boolean };
    const flat: Slot[] = [];
    pages.forEach((page, p) =>
        page.items.forEach((item, i) =>
            flat.push({
                p,
                i,
                boundary:
                    item.header || isNonEntryLabel(item.text) || isReferenceHeading(item) || isNotesHeading(item),
                ref: reference[p][i],
            }),
        ),
    );
    const reach = (from: number, step: 1 | -1) => {
        let seen = 0;
        for (let k = from + step; k >= 0 && k < flat.length; k += step) {
            if (flat[k].ref) return true;
            if (flat[k].boundary || ++seen > CANDIDATE_REACH - 1) return false;
        }
        return false;
    };
    const candidate = pages.map((page) => page.items.map(() => false));
    const inside = pages.map((page) => page.items.map(() => false));
    flat.forEach((slot, k) => {
        if (slot.ref || slot.boundary) return;
        const item = pages[slot.p].items[slot.i];
        if (item.lines.length === 0) return;
        const between = reach(k, -1) && reach(k, 1);
        if (between || (k > 0 && flat[k - 1].ref)) {
            candidate[slot.p][slot.i] = true;
            inside[slot.p][slot.i] = between;
        }
    });
    return { candidate, inside };
}

/**
 * The end of a line that leaves its entry open: a comma, colon, semicolon,
 * ampersand, slash, dash or opening bracket, or a function word ("… the
 * role of"). Other lowercase words can finish an entry ("… in press").
 */
const OPEN_LINE_END_RE =
    /(?:[,;:&(/–-]|(?:^|\s)(?:of|the|a|an|and|or|in|on|for|to|with|by|from|at|as|into|between|und|der|die|das|des|et|de|la|le|les|du|y|e)\b)\s*$/iu;

/**
 * Front- and back-matter lines that can follow a reference list at its
 * indent: publication history ("Received for publication September 2019"),
 * copyright, correspondence, funding and similar run-in labels. Their dates
 * and journal names read as bibliographic detail.
 */
const NON_ENTRY_LABEL_RE =
    /^\s*(?:©|copyright\b|(?:manuscript\s+)?(?:received|accepted|revised|submitted|resubmitted|published|first\s+published)\b|available\s+online\b|article\s+history\b|correspondence\b|corresponding\s+authors?\b|e-?mail\b|funding\b|financial\s+support\b|conflicts?\s+of\s+interests?\b|competing\s+interests?\b|declarations?\b|acknowledge?ments?\b|keywords?\b|key\s+words\b|jel\b|(?:how\s+)?to\s+cite\b|citation\s*:|supplementary\b|supporting\s+information\b|data\s+availability\b|disclosures?\b|ethics\b|author\s+contributions?\b)/iu;

/**
 * Whether the text after a list's last entry continues it. Prose and
 * front- or back-matter labels never do. Otherwise the entry's last line
 * must leave it open, or the text must carry a bibliographic detail. A
 * missing final period alone is no evidence: many styles end entries
 * without one ("… Cambridge Univ. Press"), and the text that follows the
 * list can be anything.
 */
function continuesLastEntry(previous: RefLine, text: string): boolean {
    if (proseWordCount(text) >= 2 || NON_ENTRY_LABEL_RE.test(text)) return false;
    return OPEN_LINE_END_RE.test(previous.text.trim()) || hasBibliographicDetail(text);
}

/** One item of the re-segmented document and the original lines it holds. */
interface Piece {
    item: RefItem;
    /** Original item index on the page for each of its lines. */
    origins: number[];
}

/** Rounds of candidate acceptance; each can make continuations of new entries eligible. */
const ACCEPT_ROUNDS = 3;

/**
 * Accept the candidates that read as reference entries once re-segmented.
 * Only a candidate the line plan cuts apart inside the list, or joins to the
 * reference entry before it, is eligible: the others read as they did when
 * they were scored, and scoring them again in changed company would only move
 * them around the threshold. The eligible candidates are re-segmented along
 * the line plans, the document is scored again, and a candidate is accepted
 * when every entry holding its lines scores as a reference. Accepted
 * candidates join `reference`, which can make the candidate after one
 * eligible; acceptance repeats until nothing changes.
 */
function acceptCandidates(
    model: ReferenceModel,
    pages: readonly RefPage[],
    pageCount: number,
    reference: boolean[][],
    { candidate, inside }: Candidates,
    lines: readonly LinePlan[],
): void {
    // An item after the list's last entry can only finish it, and only on
    // evidence that it does (`continuesLastEntry`).
    const continues = (p: number, i: number) => {
        if (!lines[p].mergeWithPrevious[i] || !lines[p].aligned[i] || reference[p][i - 1] !== true) return false;
        if (inside[p][i]) return true;
        const previous = pages[p].items[i - 1].lines;
        return previous.length > 0 && continuesLastEntry(previous[previous.length - 1], pages[p].items[i].text);
    };
    for (let round = 0; round < ACCEPT_ROUNDS; round++) {
        const eligible = candidate.map((c, p) =>
            c.map(
                (isCandidate, i) =>
                    isCandidate &&
                    !reference[p][i] &&
                    ((inside[p][i] && lines[p].splits[i].length > 0) || continues(p, i)),
            ),
        );
        if (!eligible.some((e) => e.some(Boolean))) return;
        const pieces = pages.map((page, p) => resegmentPage(page, reference[p], eligible[p], lines[p]));
        const rescored = scoreReferences(
            model,
            pages.map((page, p) => ({ ...page, items: pieces[p].map((piece) => piece.item) })),
            pageCount,
        );
        let changed = false;
        pages.forEach((page, p) => {
            const accepted = eligible[p].slice();
            pieces[p].forEach((piece, k) => {
                if (rescored[p][k] >= model.threshold && !isNonEntryLabel(piece.item.text)) return;
                for (const i of piece.origins) accepted[i] = false;
            });
            page.items.forEach((_, i) => {
                if (!accepted[i]) return;
                reference[p][i] = true;
                changed = true;
            });
        });
        if (!changed) return;
    }
}

/**
 * The page's items with the reference items and eligible candidates split
 * along their line plans, and joined to the previous entry where the plan
 * says they continue it. Only a reference entry takes a continuation: a
 * candidate has yet to show it is one (a running head above an entry's
 * continuation at the top of a page is a candidate too).
 */
function resegmentPage(
    page: RefPage,
    reference: readonly boolean[],
    eligible: readonly boolean[],
    plan: LinePlan,
): Piece[] {
    const out: Piece[] = [];
    // Whether the last piece ends a reference item, which a continuation may join.
    let joinable = false;
    page.items.forEach((item, i) => {
        if (!(reference[i] || eligible[i])) {
            out.push({ item, origins: item.lines.map(() => i) });
            joinable = false;
            return;
        }
        const cuts = [...plan.splits[i].filter((k) => k > 0 && k < item.lines.length), item.lines.length];
        let start = 0;
        for (const cut of cuts) {
            const group = item.lines.slice(start, cut);
            const previous = out[out.length - 1];
            if (start === 0 && plan.mergeWithPrevious[i] && joinable && previous) {
                const merged = [...previous.item.lines, ...group];
                out[out.length - 1] = {
                    item: { ...previous.item, text: joinLines(merged.map((l) => l.text)), lines: merged },
                    origins: [...previous.origins, ...group.map(() => i)],
                };
            } else {
                const whole = start === 0 && cut === item.lines.length;
                out.push({
                    item: whole ? item : { ...item, text: joinLines(group.map((l) => l.text)), lines: group },
                    origins: group.map(() => i),
                });
            }
            start = cut;
        }
        joinable = reference[i];
    });
    return out;
}

const LINE_HAS_PREV = LINE_FEATURES.indexOf("hasPrev");

/**
 * Apply a page plan to its draft items. Returns the edited items: reference
 * entries become `reference` items, an item holding several entries is split
 * at their first lines, and an item that continues the previous entry in the
 * same column is merged into it. Items are rebuilt from their lines (text via
 * `joinLines`) when the plan splits or merges anything on the page; otherwise
 * only reference items are relabeled.
 */
export function applyReferencePlan(
    items: readonly DraftItem[],
    plan: ReferencePagePlan,
    removeHyphenation = true,
): DraftItem[] {
    const edits = plan.splits.some((s) => s.length > 0) || plan.mergeWithPrevious.some(Boolean);
    if (!edits) {
        return items.map((item, i) => (plan.reference[i] ? { ...item, kind: "reference" } : item));
    }

    const out: DraftItem[] = [];
    const push = (base: DraftItem, lines: PageLine[], roles: HangingRole[], isRef: boolean, piece = false) => {
        const text = joinLines(lines.map((l) => l.text), removeHyphenation);
        const bbox = mergeBoxes(lines.map((l) => l.bbox));
        // A list heading the detector merged into the first entry ("FURTHER
        // READING Heyman, K. …") is split off as a piece of its own; it is the
        // list's heading, not an entry.
        if (isRef && piece && isReferenceHeading({ header: false, column: 0, text, lines: [] })) {
            out.push({ ...base, kind: "section_header", text, bbox, lines, roles });
            return;
        }
        out.push({ ...base, kind: isRef ? "reference" : base.kind, text, bbox, lines, roles });
    };

    items.forEach((item, i) => {
        const group = item.lines;
        const isRef = plan.reference[i];
        if (group.length === 0) {
            // No lines to rebuild from (not produced by the detector); keep as is.
            out.push(isRef ? { ...item, kind: "reference" } : item);
            return;
        }
        const cuts = isRef
            ? plan.splits[i].filter((k) => k > 0 && k < group.length).sort((a, b) => a - b)
            : [];
        let start = 0;
        for (const cut of [...cuts, group.length]) {
            if (cut <= start) continue;
            const previous = out[out.length - 1];
            if (
                start === 0 &&
                isRef &&
                plan.mergeWithPrevious[i] &&
                previous?.kind === "reference" &&
                previous.columnIndex === item.columnIndex
            ) {
                // The item's opening lines finish the previous entry.
                out.pop();
                push(
                    previous,
                    [...previous.lines, ...group.slice(0, cut)],
                    [...previous.roles, ...item.roles.slice(0, cut)],
                    true,
                );
            } else {
                push(item, group.slice(start, cut), item.roles.slice(start, cut), isRef, cuts.length > 0);
            }
            start = cut;
        }
    });
    return out;
}
