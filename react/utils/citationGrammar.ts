import { ID_PREFIXES } from '../../src/beaver-extract/schema/schema';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import type { ZoteroItemReference } from '../types/zotero';

export type LocatorKind =
    | 'page'
    | 'sentence'
    | 'line'
    | 'paragraph'
    | 'heading'
    | 'list'
    | 'caption'
    | 'footnote'
    | 'figure'
    | 'equation'
    | 'table'
    | 'margin'
    | 'unknown';

export interface Locator {
    kind: LocatorKind;
    value: string;
    raw: string;
}

export type ExternalCitationSource = 'openalex' | 'semantic_scholar' | (string & {});

export interface ZoteroCitationRef extends ZoteroItemReference {
    kind: 'zotero';
    loc?: Locator;
}

export interface ExternalCitationRef {
    kind: 'external';
    external_id: string;
    source?: ExternalCitationSource;
    loc?: Locator;
}

/** User-attached external file (model-facing id `ext-<KEY>`). */
export interface ExternalFileCitationRef {
    kind: 'external_file';
    ext_key: string;
    loc?: Locator;
}

export type CitationRef = ZoteroCitationRef | ExternalCitationRef | ExternalFileCitationRef;

// Model-facing external file id, e.g. "ext-AB12CD34" (case-insensitive,
// normalized to an uppercase key).
const EXTERNAL_FILE_ID_RE = /^ext-([A-Za-z0-9]{8})$/i;

export function parseExternalFileId(raw: string | undefined): string | null {
    if (!raw) return null;
    const match = EXTERNAL_FILE_ID_RE.exec(stripClobberPrefix(raw));
    return match ? match[1].toUpperCase() : null;
}

export type NormalizeCitationResult =
    | { ok: true; ref: CitationRef; rawAttrs: Record<string, string> }
    | {
        ok: false;
        reason: 'missing_identity' | 'conflicting_identity' | 'invalid_zotero_id' | 'invalid_external_id';
        rawAttrs: Record<string, string>;
        requestedKey?: string;
        rawIdentity?: string;
        identityAttr?: 'id' | 'item_id' | 'att_id' | 'attachment_id' | 'external_id';
    };

type CitationLike = {
    requested_ref?: CitationRef;
    resolved_ref?: CitationRef;
    raw_tag?: string;
};

const CLOBBER_PREFIX = 'user-content-';

const LOC_PREFIXES: Array<{ prefix: string; kind: LocatorKind; numericOnly?: boolean }> = [
    { prefix: 'paragraph', kind: 'paragraph', numericOnly: true },
    { prefix: 'heading', kind: 'heading', numericOnly: true },
    { prefix: 'caption', kind: 'caption', numericOnly: true },
    { prefix: 'footnote', kind: 'footnote', numericOnly: true },
    { prefix: 'margin', kind: 'margin', numericOnly: true },
    { prefix: 'table', kind: 'table', numericOnly: true },
    { prefix: 'page', kind: 'page' },
    { prefix: 'list', kind: 'list', numericOnly: true },
    { prefix: 'l', kind: 'line', numericOnly: true },
    { prefix: 'fig', kind: 'figure', numericOnly: true },
    { prefix: 'tab', kind: 'table', numericOnly: true },
    { prefix: 'eq', kind: 'equation', numericOnly: true },
    { prefix: 'p', kind: 'paragraph', numericOnly: true },
    { prefix: 's', kind: 'sentence', numericOnly: true },
];

const CITATION_INDEX_PREFIXES: Partial<Record<LocatorKind, string>> = {
    sentence: ID_PREFIXES.sentence,
    line: ID_PREFIXES.line,
    paragraph: ID_PREFIXES.text,
    heading: ID_PREFIXES.section_header,
    list: ID_PREFIXES.list_item,
    caption: ID_PREFIXES.caption,
    footnote: ID_PREFIXES.footnote,
    figure: ID_PREFIXES.picture,
    equation: ID_PREFIXES.formula,
    table: ID_PREFIXES.table,
    margin: ID_PREFIXES.margin,
};

function stripClobberPrefix(value: string): string {
    return value.startsWith(CLOBBER_PREFIX) ? value.slice(CLOBBER_PREFIX.length) : value;
}

function locPrefixFor(raw: string): { prefix: string; kind: LocatorKind; value: string } | null {
    for (const entry of LOC_PREFIXES) {
        if (raw.startsWith(entry.prefix) && raw.length > entry.prefix.length) {
            const value = raw.slice(entry.prefix.length);
            if (entry.numericOnly && !/^\d+(?:-.+)?$/.test(value)) continue;
            return { prefix: entry.prefix, kind: entry.kind, value };
        }
    }
    return null;
}

/**
 * Parse compact page locators and Beaver Extract record ids.
 */
export function parseLoc(token: string | undefined): Locator | undefined {
    if (token == null) return undefined;
    const raw = token;
    if (!raw) return { kind: 'unknown', value: raw, raw };

    const first = locPrefixFor(raw);
    if (!first || !first.value) {
        return { kind: 'unknown', value: raw, raw };
    }

    let value = first.value;
    const rangeDash = first.value.indexOf('-');
    if (rangeDash >= 0) {
        const left = first.value.slice(0, rangeDash);
        const rightRaw = first.value.slice(rangeDash + 1);
        const right = locPrefixFor(rightRaw);
        if (left && right && right.kind === first.kind && right.prefix === first.prefix && right.value) {
            value = `${left}-${right.value}`;
        }
    }

    return { kind: first.kind, value, raw };
}

function rawRangeCandidateIds(raw: string): string[] {
    const ids = new Set<string>([raw]);
    const parts = raw.split('-');
    if (parts.length === 2 && parts[0] && parts[1]) {
        const left = parts[0];
        const right = parts[1];
        ids.add(left);
        if (/^[A-Za-z_]/.test(right)) {
            ids.add(right);
        } else {
            const prefix = left.match(/^[A-Za-z_]+/)?.[0];
            ids.add(prefix ? `${prefix}${right}` : right);
        }
    }
    return [...ids];
}

/**
 * Return structured extraction citation-index ids addressed by a locator.
 */
export function citationIndexCandidateIdsForLocator(locator: Locator): string[] {
    const prefix = CITATION_INDEX_PREFIXES[locator.kind];
    if (!prefix) return rawRangeCandidateIds(locator.raw);

    const ids = new Set<string>();
    const values = locator.value.split('-');
    const addValue = (value: string) => {
        if (/^\d+$/.test(value)) ids.add(`${prefix}${value}`);
    };

    if (values.length === 1) {
        addValue(values[0]);
    } else if (values.length === 2) {
        addValue(values[0]);
        addValue(values[1]);
    }

    return ids.size > 0 ? [...ids] : rawRangeCandidateIds(locator.raw);
}

/**
 * Build a page locator from the legacy bare page attribute.
 */
export function locatorFromLegacyPage(page: string | undefined): Locator | undefined {
    if (page == null) return undefined;
    return { kind: 'page', value: page, raw: page };
}

/**
 * Parse a Zotero object identity of the form "libraryID-zoteroKey".
 */
export function parseZoteroId(raw: string | undefined): ZoteroItemReference | null {
    if (!raw) return null;
    const clean = stripClobberPrefix(raw);
    const dashIndex = clean.indexOf('-');
    if (dashIndex <= 0) return null;

    const libraryRaw = clean.slice(0, dashIndex);
    if (!/^[1-9]\d*$/.test(libraryRaw)) return null;

    const zoteroKey = clean.slice(dashIndex + 1);
    if (!zoteroKey) return null;

    const libraryID = Number(libraryRaw);
    return {
        library_id: libraryID,
        zotero_key: zoteroKey,
        library_ref: libraryRefForLibraryID(libraryID) ?? undefined,
    };
}

function getLocator(rawAttrs: Record<string, string>): Locator | undefined {
    if (rawAttrs.loc != null) return parseLoc(rawAttrs.loc);
    if (rawAttrs.sid != null) return parseLoc(rawAttrs.sid);
    if (rawAttrs.page != null) return locatorFromLegacyPage(rawAttrs.page);
    return undefined;
}

function firstZoteroIdentity(rawAttrs: Record<string, string>): {
    attr: 'id' | 'att_id' | 'attachment_id' | 'item_id';
    value: string;
} | null {
    for (const attr of ['id', 'att_id', 'attachment_id', 'item_id'] as const) {
        if (rawAttrs[attr] != null) return { attr, value: rawAttrs[attr] };
    }
    return null;
}

/**
 * Normalize new and legacy citation tag attributes into a single internal model.
 */
export function normalizeCitationTag(rawAttrs: Record<string, string>): NormalizeCitationResult {
    const zoteroIdentity = firstZoteroIdentity(rawAttrs);
    const externalValue = rawAttrs.external_id;

    if (zoteroIdentity && externalValue != null) {
        const rawIdentity = stripClobberPrefix(zoteroIdentity.value);
        return {
            ok: false,
            reason: 'conflicting_identity',
            rawAttrs,
            rawIdentity,
            identityAttr: zoteroIdentity.attr,
            requestedKey: rawIdentity ? `invalid:${rawIdentity}` : undefined,
        };
    }

    const loc = getLocator(rawAttrs);
    if (zoteroIdentity) {
        const rawIdentity = stripClobberPrefix(zoteroIdentity.value);
        // External-file ids (ext-<KEY>) arrive under the generic id= attribute;
        // match them before the Zotero parse, which would reject them.
        const extKey = parseExternalFileId(zoteroIdentity.value);
        if (extKey) {
            return {
                ok: true,
                rawAttrs,
                ref: { kind: 'external_file', ext_key: extKey, ...(loc ? { loc } : {}) },
            };
        }
        const parsed = parseZoteroId(zoteroIdentity.value);
        if (!parsed) {
            return {
                ok: false,
                reason: 'invalid_zotero_id',
                rawAttrs,
                rawIdentity,
                identityAttr: zoteroIdentity.attr,
                requestedKey: rawIdentity ? `invalid:${rawIdentity}` : undefined,
            };
        }
        return { ok: true, rawAttrs, ref: { kind: 'zotero', ...parsed, ...(loc ? { loc } : {}) } };
    }

    if (externalValue != null) {
        const rawIdentity = stripClobberPrefix(externalValue);
        if (!rawIdentity.trim()) {
            return {
                ok: false,
                reason: 'invalid_external_id',
                rawAttrs,
                rawIdentity,
                identityAttr: 'external_id',
            };
        }
        return {
            ok: true,
            rawAttrs,
            ref: { kind: 'external', external_id: rawIdentity, ...(loc ? { loc } : {}) },
        };
    }

    return { ok: false, reason: 'missing_identity', rawAttrs };
}

export function baseCitationKey(ref: CitationRef): string {
    if (ref.kind === 'zotero') return `zotero:${ref.library_id}-${ref.zotero_key}`;
    if (ref.kind === 'external_file') return `extfile:${ref.ext_key}`;
    if (ref.kind === 'external') {
        return ref.source ? `external:${ref.source}:${ref.external_id}` : externalCompatKey(ref.external_id);
    }
    // Unknown/future ref kind (e.g. another connected app's resource that an
    // older client doesn't model). Keep a stable, kind-namespaced key so the
    // citation degrades gracefully — markers/lookups don't collide all unknowns
    // onto one key, and nothing throws — instead of assuming a closed set.
    const unknown = ref as { kind: string; loc?: unknown } & Record<string, unknown>;
    const { loc: _loc, ...identity } = unknown;
    return `${unknown.kind}:${JSON.stringify(identity)}`;
}

export function requestedCitationKey(ref: CitationRef): string {
    const base = baseCitationKey(ref);
    return ref.loc ? `${base}:${ref.loc.raw}` : base;
}

export function externalCompatKey(external_id: string, loc?: Locator): string {
    const base = `external:${external_id}`;
    return loc ? `${base}:${loc.raw}` : base;
}

export function getPageLocator(ref: CitationRef): string | undefined {
    return ref.loc?.kind === 'page' ? ref.loc.value : undefined;
}

function locFromRawTag(rawTag: string | undefined): Locator | undefined {
    if (!rawTag) return undefined;
    const match = rawTag.match(/^<citation\b([^>]*)/i);
    if (!match) return undefined;
    const attrs = parseRawCitationAttributes(match[1] || '');
    const normalized = normalizeCitationTag(attrs);
    return normalized.ok ? normalized.ref.loc : undefined;
}

function withLocFromRawTag<T extends CitationRef>(ref: T, rawTag: string | undefined): T {
    if (ref.loc) return ref;
    const loc = locFromRawTag(rawTag);
    return loc ? ({ ...ref, loc } as T) : ref;
}

function withLoc<T extends CitationRef>(ref: T, loc: Locator | undefined): T {
    return !ref.loc && loc ? ({ ...ref, loc } as T) : ref;
}

export function getRequestedRef(meta: CitationLike): CitationRef | null {
    if (meta.requested_ref) {
        return withLocFromRawTag(meta.requested_ref, meta.raw_tag);
    }
    if (!meta.raw_tag) return null;
    const match = meta.raw_tag.match(/^<citation\b([^>]*)/i);
    if (!match) return null;
    const attrs = parseRawCitationAttributes(match[1] || '');
    const normalized = normalizeCitationTag(attrs);
    return normalized.ok ? normalized.ref : null;
}

export function getResolvedRef(meta: CitationLike): CitationRef | null {
    if (!meta.resolved_ref) return null;
    const requested = getRequestedRef(meta);
    return withLoc(
        withLocFromRawTag(meta.resolved_ref, meta.raw_tag),
        requested?.loc,
    );
}

export function parseRawCitationAttributes(attributesStr: string | undefined): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (!attributesStr) return attrs;

    const attrRegex = /([\w-]+)=(?:"([^"]*)"|\\"([^\\"]*)\\"|'([^']*)'|\\'([^\\']*)\\')/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(attributesStr)) !== null) {
        attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    }
    return attrs;
}

export function getInvalidCitationFallbackKeyFromAttrs(rawAttrs: Record<string, string>): string | null {
    const normalized = normalizeCitationTag(rawAttrs);
    if (normalized.ok) return null;
    return normalized.rawIdentity ? `invalid:${normalized.rawIdentity}` : null;
}
