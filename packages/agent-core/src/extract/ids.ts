import { ID_PREFIXES } from './schema';

/**
 * How extraction ids are numbered.
 *
 * - `document`: one counter per kind across the whole document (`s243`).
 *   PDF schema 4.
 * - `page`: one counter per kind per page, prefixed by the 1-based physical
 *   page (`s5.6` is sentence 6 on page 5). PDF schema 5.
 *
 * The two shapes never overlap, so an id names the schema it came from.
 */
export type ExtractIdScheme = 'document' | 'page';

export interface ParsedExtractId {
    prefix: string;
    /** 1-based physical page; only set for page-scoped ids. */
    page?: number;
    /** Counter within the document (`document`) or within the page (`page`). */
    n: number;
    scheme: ExtractIdScheme;
}

const EXTRACT_ID_PREFIXES: ReadonlySet<string> = new Set(Object.values(ID_PREFIXES));
const EXTRACT_ID_RE = /^([a-z]+)(\d+(?:\.\d+)?)$/;
const EXTRACT_ID_VALUE_RE = /^(\d+)(?:\.(\d+))?$/;

/** Format an extraction id; pass `page` (1-based) for a page-scoped id. */
export function formatExtractId(prefix: string, n: number, page?: number): string {
    return page === undefined ? `${prefix}${n}` : `${prefix}${page}.${n}`;
}

/** Parse the part of an id after its prefix (`243`, `5.6`); `null` otherwise. */
export function parseExtractIdValue(value: string): Omit<ParsedExtractId, 'prefix'> | null {
    const match = EXTRACT_ID_VALUE_RE.exec(value);
    if (!match) return null;
    if (match[2] === undefined) return { n: Number(match[1]), scheme: 'document' };
    return { page: Number(match[1]), n: Number(match[2]), scheme: 'page' };
}

/** Parse a canonical extraction id (`s243`, `s5.6`, `heading2.1`); `null` otherwise. */
export function parseExtractId(raw: string): ParsedExtractId | null {
    const match = EXTRACT_ID_RE.exec(raw);
    if (!match || !EXTRACT_ID_PREFIXES.has(match[1])) return null;
    const value = parseExtractIdValue(match[2]);
    return value && { prefix: match[1], ...value };
}

/** The PDF schema version whose extraction produces ids of this scheme. */
export function schemaVersionForIdScheme(scheme: ExtractIdScheme): string {
    return scheme === 'page' ? '5' : '4';
}
