/**
 * The row merge: a paper never appears twice in a table.
 *
 * Rows that share a Zotero key, an external id or a file are one row;
 * otherwise the most specific identifier kind both rows carry decides (DOI
 * normalised and case-folded, PMID, arXiv without its version, ISBN as
 * ISBN-13, never for book sections); otherwise title plus year when neither
 * row has an identifier kind the other also has. Among new rows a Zotero row
 * wins over an external or file row. A stored row keeps its id and reference
 * and gains the new origin; stored rows are never merged with each other,
 * since that would delete one with its cells and the user's corrections.
 *
 * Held to the `table-merges` fixtures. Pure: no Zotero.
 */

import {
    IDENTIFIER_COLUMN_ID,
    REFERENCE_COLUMN_ID,
    YEAR_COLUMN_ID,
    allocateRowId,
    type Cell,
    type Row,
    type RowOrigin,
} from "./table";

/** Most specific first: the identifier column shows the first one a row has. */
export const IDENTIFIER_KINDS = ["doi", "pmid", "arxiv", "isbn"] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** Item and publication types that share their book's ISBN. */
const SECTION_TYPES = new Set(["bookSection", "book_chapter", "book-chapter", "book-section", "book-part"]);

export const IDENTIFIER_LINKS: Record<IdentifierKind, [string, string]> = {
    doi: ["https://doi.org/", ""],
    pmid: ["https://pubmed.ncbi.nlm.nih.gov/", "PMID "],
    arxiv: ["https://arxiv.org/abs/", "arXiv:"],
    isbn: ["https://www.worldcat.org/isbn/", "ISBN "],
};

/** Bibliographic identifiers as metadata carries them, before normalising. */
export interface RawIdentifiers {
    doi?: string | null;
    pmid?: string | number | null;
    arxiv?: string | null;
    arXivID?: string | null;
    isbn?: string | null;
}

// --- identifiers -------------------------------------------------------------

const DOI_START = /10\.\d{4,9}\//;
const DOI_PREFIX = /^\s*(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const DOI_BRACKETS: [string, string][] = [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]];

function count(text: string, char: string): number {
    return text.split(char).length - 1;
}

/** A bare DOI out of however it was stored, or null when there is none. */
export function normalizeDoi(value: string | null | undefined): string | null {
    if (!value) return null;
    const text = value.trim().normalize("NFKC").replace(DOI_PREFIX, "");
    const match = DOI_START.exec(text);
    if (!match) return null;
    let doi = text.slice(match.index).split(/\s+/)[0];
    let changed = true;
    while (changed) {
        changed = false;
        const stripped = doi.replace(/[.,;:]+$/, "");
        if (stripped !== doi) {
            doi = stripped;
            changed = true;
        }
        for (const [opener, closer] of DOI_BRACKETS) {
            if (doi.endsWith(closer) && count(doi, closer) > count(doi, opener)) {
                doi = doi.slice(0, -1);
                changed = true;
            }
        }
    }
    return doi || null;
}

function normalizePmid(value: string): string | null {
    const text = value.replace(/^\s*pmid\s*:?\s*/i, "").trim();
    return /^\d{1,9}$/.test(text) ? text : null;
}

function normalizeArxiv(value: string): string | null {
    const text = value.replace(/^\s*(?:arxiv\s*:\s*|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)/i, "").trim();
    const match = /^(\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i.exec(text);
    return match ? match[1] : null;
}

function isbn13(digits: string): string {
    const core = "978" + digits.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < core.length; i++) sum += (i % 2 ? 3 : 1) * Number(core[i]);
    return core + String((10 - (sum % 10)) % 10);
}

function validIsbn(digits: string): boolean {
    if (digits.length === 10 && /^\d{9}[\dX]$/.test(digits)) {
        let total = 0;
        for (let i = 0; i < 10; i++) total += (10 - i) * (digits[i] === "X" ? 10 : Number(digits[i]));
        return total % 11 === 0;
    }
    if (digits.length === 13 && /^\d{13}$/.test(digits)) {
        let total = 0;
        for (let i = 0; i < 13; i++) total += (i % 2 ? 3 : 1) * Number(digits[i]);
        return total % 10 === 0;
    }
    return false;
}

/**
 * Every valid ISBN in a field, as ISBN-13. Consecutive groups are joined
 * until they form an ISBN whose check digit holds.
 */
function normalizeIsbns(value: string): string[] {
    const text = value.replace(/isbn(?:-1[03])?\s*:?/gi, " ");
    const groups = (text.match(/[0-9Xx][0-9Xx-]*/g) ?? []).map((g) => g.replace(/-/g, "").toUpperCase());
    const result: string[] = [];
    let start = 0;
    while (start < groups.length) {
        let joined = "";
        let found: [string, number] | null = null;
        for (let end = start; end < groups.length; end++) {
            joined += groups[end];
            if (joined.length > 13) break;
            if (validIsbn(joined) && (found === null || joined.length === 13)) found = [joined, end];
        }
        if (found) {
            const [digits, end] = found;
            result.push(digits.length === 13 ? digits : isbn13(digits));
            start = end;
        }
        start += 1;
    }
    return [...new Set(result)];
}

/** Normalised identifiers by kind, in {@link IDENTIFIER_KINDS} order. */
export function normalizeIdentifiers(source: RawIdentifiers | null | undefined): Partial<Record<IdentifierKind, string[]>> {
    if (!source) return {};
    const found: Partial<Record<IdentifierKind, string[]>> = {};
    const doi = normalizeDoi(source.doi);
    if (doi) found.doi = [doi];
    if (source.pmid != null && source.pmid !== "") {
        const pmid = normalizePmid(String(source.pmid));
        if (pmid) found.pmid = [pmid];
    }
    const arxivRaw = source.arXivID || source.arxiv;
    if (arxivRaw) {
        const arxiv = normalizeArxiv(String(arxivRaw));
        if (arxiv) found.arxiv = [arxiv];
    }
    if (source.isbn) {
        const isbns = normalizeIsbns(String(source.isbn));
        if (isbns.length) found.isbn = isbns;
    }
    return found;
}

/** The best identifier a row has, as the identifier column's link cell. */
export function identifierCell(identifiers: Partial<Record<IdentifierKind, string[]>>): Cell | undefined {
    for (const kind of IDENTIFIER_KINDS) {
        const value = identifiers[kind]?.[0];
        if (!value) continue;
        const [base, prefix] = IDENTIFIER_LINKS[kind];
        return { outcome: "answered", provenance: "system", value: { kind: "link", url: base + value, label: prefix + value } };
    }
    return undefined;
}

function identifierFromCell(cell: Cell | undefined): [IdentifierKind, string] | null {
    const value = cell?.value;
    if (value?.kind !== "link") return null;
    for (const kind of IDENTIFIER_KINDS) {
        const [base] = IDENTIFIER_LINKS[kind];
        if (value.url.startsWith(base)) return [kind, value.url.slice(base.length)];
    }
    return null;
}

// --- identity ----------------------------------------------------------------

/** What identifies a row's work for merging. */
export interface RowIdentity {
    /** `kind\u0000value`, values case-folded. */
    identifiers: Set<string>;
    /** Reference keys: Zotero items, external works, files. */
    keys: Set<string>;
    /** Normalised `title\u0000year` pairs; a merged row keeps every one it gathered. */
    titleYears: Set<string>;
}

function titleKey(title: string | null | undefined): string | null {
    if (!title) return null;
    const text = title.normalize("NFKD").toLowerCase();
    const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
    // Short titles ("Editorial", "Introduction") do not identify a work.
    return words.length >= 3 ? words.join(" ") : null;
}

function zoteroKey(ref: { library_ref: string; zotero_key: string }): string {
    return `zotero:${ref.library_ref}:${ref.zotero_key}`;
}

/**
 * The row's identity from its reference and cells, plus the full metadata
 * identifiers of a row being added (a stored row keeps only its best one, in
 * the identifier column).
 */
export function identityOf(row: Row, identifiers?: RawIdentifiers | null): RowIdentity {
    const found = normalizeIdentifiers(identifiers);
    const add = (kind: IdentifierKind, values: string[]) => {
        found[kind] = [...(found[kind] ?? []), ...values];
    };
    const keys = new Set<string>();
    let section = false;
    const ref = row.ref;
    if (ref) {
        if (ref.kind === "item") {
            keys.add(zoteroKey(ref));
        } else if (ref.kind === "external") {
            keys.add(`external:${ref.source_id}`);
            const reference = ref.reference as
                | { identifiers?: RawIdentifiers | null; publication_types?: string[] | null }
                | undefined;
            if (reference) {
                for (const [kind, values] of Object.entries(normalizeIdentifiers(reference.identifiers)))
                    add(kind as IdentifierKind, values!);
                section = (reference.publication_types ?? []).some((t) => SECTION_TYPES.has(t));
            }
        }
    }
    const pair = identifierFromCell(row.cells[IDENTIFIER_COLUMN_ID]);
    if (pair) add(pair[0], [pair[1]]);
    const reference = row.cells[REFERENCE_COLUMN_ID]?.value;
    const itemType = reference?.kind === "reference" ? reference.item_type : undefined;
    if (section || (itemType && SECTION_TYPES.has(itemType))) delete found.isbn;
    const yearValue = row.cells[YEAR_COLUMN_ID]?.value;
    const year = yearValue?.kind === "date" ? yearValue.value.slice(0, 4) : null;
    const title = titleKey(reference?.kind === "reference" ? reference.title : null);
    const identifiersSet = new Set<string>();
    for (const kind of IDENTIFIER_KINDS)
        for (const value of found[kind] ?? []) identifiersSet.add(`${kind}\u0000${value.toLowerCase()}`);
    return {
        identifiers: identifiersSet,
        keys,
        titleYears: title && year ? new Set([`${title}\u0000${year}`]) : new Set(),
    };
}

function values(identity: RowIdentity, kind: IdentifierKind): Set<string> {
    const out = new Set<string>();
    const prefix = `${kind}\u0000`;
    for (const token of identity.identifiers) if (token.startsWith(prefix)) out.add(token);
    return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
    for (const value of a) if (b.has(value)) return true;
    return false;
}

/** The merge rule. */
export function sameWork(a: RowIdentity, b: RowIdentity): boolean {
    if (intersects(a.keys, b.keys)) return true;
    for (const kind of IDENTIFIER_KINDS) {
        const ours = values(a, kind);
        const theirs = values(b, kind);
        if (ours.size && theirs.size) return intersects(ours, theirs);
    }
    return intersects(a.titleYears, b.titleYears);
}

/** Whether two identities carry a common identifier kind with different values. */
function conflicting(a: RowIdentity, b: RowIdentity): boolean {
    for (const kind of IDENTIFIER_KINDS) {
        const ours = values(a, kind);
        const theirs = values(b, kind);
        if (ours.size && theirs.size) return !intersects(ours, theirs);
    }
    return false;
}

function union(a: RowIdentity, b: RowIdentity): RowIdentity {
    return {
        identifiers: new Set([...a.identifiers, ...b.identifiers]),
        keys: new Set([...a.keys, ...b.keys]),
        titleYears: new Set([...a.titleYears, ...b.titleYears]),
    };
}

function tokens(identity: RowIdentity): string[] {
    return [
        ...[...identity.identifiers].map((t) => `i:${t}`),
        ...[...identity.keys].map((t) => `k:${t}`),
        ...[...identity.titleYears].map((t) => `t:${t}`),
    ];
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function isZotero(row: Row): boolean {
    return row.ref?.kind === "item";
}

function unionOrigins(first: RowOrigin[] | undefined, second: RowOrigin[] | undefined): RowOrigin[] | undefined {
    const seen = new Set<string>();
    const merged: RowOrigin[] = [];
    for (const origin of [...(first ?? []), ...(second ?? [])]) {
        if (seen.has(origin.source)) continue;
        seen.add(origin.source);
        merged.push({ ...origin });
    }
    return merged.length ? merged : undefined;
}

export interface MergeResult {
    /** The stored rows (updated) followed by the rows added. */
    rows: Row[];
    /** Ids of the rows added, in order. */
    added: string[];
    /** Incoming rows folded into another row. */
    merged: number;
    /** For each incoming row, the id of the row it ended in. */
    landed: string[];
}

interface Entry {
    row: Row;
    identity: RowIdentity;
    existing: boolean;
    position: number;
    alive: boolean;
}

/**
 * Folds `incoming` rows (each with its metadata identifiers) into `existing`.
 * An incoming row that is the same work as rows already present joins them:
 * a stored row when one matches, otherwise the first new row that does, and
 * new rows it shows to be one work are folded together too, so the result
 * does not depend on input order. Inputs are not modified.
 */
export function mergeRows(
    existing: readonly Row[],
    incoming: readonly { row: Row; identifiers?: RawIdentifiers | null }[],
): MergeResult {
    const entries: Entry[] = [];
    const index = new Map<string, number[]>();
    const register = (entry: Entry, identity: RowIdentity) => {
        for (const token of tokens(identity)) {
            const list = index.get(token);
            if (list) list.push(entry.position);
            else index.set(token, [entry.position]);
        }
    };
    const matches = (identity: RowIdentity): Entry[] => {
        const candidates = new Set<number>();
        for (const token of tokens(identity)) for (const position of index.get(token) ?? []) candidates.add(position);
        return [...candidates]
            .sort((a, b) => a - b)
            .map((p) => entries[p])
            .filter((entry) => entry.alive && sameWork(entry.identity, identity));
    };
    const absorb = (target: Entry, row: Row, identity: RowIdentity) => {
        const origin = unionOrigins(target.row.origin, row.origin);
        if (!target.existing && isZotero(row) && !isZotero(target.row)) target.row = { ...clone(row), id: target.row.id };
        else target.row = { ...target.row };
        if (origin) target.row.origin = origin;
        else delete target.row.origin;
        target.identity = union(target.identity, identity);
        register(target, identity);
    };

    for (const row of existing) {
        const entry: Entry = { row: clone(row), identity: identityOf(row), existing: true, position: entries.length, alive: true };
        entries.push(entry);
        register(entry, entry.identity);
    }
    const added: string[] = [];
    const landedEntries: Entry[] = [];
    let merged = 0;
    const taken = new Set(existing.map((row) => row.id));
    for (const { row: raw, identifiers } of incoming) {
        const identity = identityOf(raw, identifiers);
        const found = matches(identity);
        if (!found.length) {
            const row = clone(raw);
            if (taken.has(row.id)) row.id = allocateRowId(taken);
            taken.add(row.id);
            const entry: Entry = { row, identity, existing: false, position: entries.length, alive: true };
            entries.push(entry);
            register(entry, identity);
            added.push(row.id);
            landedEntries.push(entry);
            continue;
        }
        const target = found.find((entry) => entry.existing) ?? found[0];
        // The incoming row joins first, so the identifiers it bridges with (a
        // DOI over differing ISBNs) decide the folds below whatever the order.
        absorb(target, raw, identity);
        merged += 1;
        landedEntries.push(target);
        for (const other of found) {
            // Folding another match in must not join two works whose
            // identifiers disagree, whatever the incoming row says.
            if (other === target || other.existing || conflicting(target.identity, other.identity)) continue;
            absorb(target, other.row, other.identity);
            other.alive = false;
            added.splice(added.indexOf(other.row.id), 1);
            for (let i = 0; i < landedEntries.length; i++) if (landedEntries[i] === other) landedEntries[i] = target;
            merged += 1;
        }
    }
    return {
        rows: entries.filter((entry) => entry.alive).map((entry) => entry.row),
        added,
        merged,
        landed: landedEntries.map((entry) => entry.row.id),
    };
}
