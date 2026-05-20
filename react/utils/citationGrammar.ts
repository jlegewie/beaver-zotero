import type { ZoteroItemReference } from '../types/zotero';

export type LocatorKind = 'page' | 'sentence' | 'figure' | 'equation' | 'table' | 'unknown';

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

export type CitationRef = ZoteroCitationRef | ExternalCitationRef;

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

type CitationMetadataLike = {
    library_id?: number;
    zotero_key?: string;
    external_source?: ExternalCitationSource;
    external_source_id?: string;
    raw_tag?: string;
};

const CLOBBER_PREFIX = 'user-content-';

const LOC_PREFIXES: Array<{ prefix: string; kind: LocatorKind }> = [
    { prefix: 'page', kind: 'page' },
    { prefix: 'fig', kind: 'figure' },
    { prefix: 'tab', kind: 'table' },
    { prefix: 'eq', kind: 'equation' },
    { prefix: 'p', kind: 'page' },
    { prefix: 's', kind: 'sentence' },
];

function stripClobberPrefix(value: string): string {
    return value.startsWith(CLOBBER_PREFIX) ? value.slice(CLOBBER_PREFIX.length) : value;
}

function locPrefixFor(raw: string): { prefix: string; kind: LocatorKind; value: string } | null {
    for (const entry of LOC_PREFIXES) {
        if (raw.startsWith(entry.prefix) && raw.length > entry.prefix.length) {
            return { ...entry, value: raw.slice(entry.prefix.length) };
        }
    }
    return null;
}

/**
 * Parse a compact locator token such as "p10", "s0-s8", or "fig2".
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

    return { library_id: Number(libraryRaw), zotero_key: zoteroKey };
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
    if (ref.source) return `external:${ref.source}:${ref.external_id}`;
    return externalCompatKey(ref.external_id);
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

export function getRequestedRef(meta: CitationMetadataLike): CitationRef | null {
    if (!meta.raw_tag) return null;
    const match = meta.raw_tag.match(/^<citation\b([^>]*)/i);
    if (!match) return null;
    const attrs = parseRawCitationAttributes(match[1] || '');
    const normalized = normalizeCitationTag(attrs);
    return normalized.ok ? normalized.ref : null;
}

export function getResolvedRef(meta: CitationMetadataLike): CitationRef | null {
    const requested = getRequestedRef(meta);
    const loc = requested?.loc;

    if (meta.library_id && meta.zotero_key) {
        return { kind: 'zotero', library_id: meta.library_id, zotero_key: meta.zotero_key, ...(loc ? { loc } : {}) };
    }
    if (meta.external_source_id) {
        return {
            kind: 'external',
            external_id: meta.external_source_id,
            ...(meta.external_source ? { source: meta.external_source } : {}),
            ...(loc ? { loc } : {}),
        };
    }
    return null;
}

export function parseRawCitationAttributes(attributesStr: string | undefined): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (!attributesStr) return attrs;

    const attrRegex = /([\w-]+)=(?:"([^"]*)"|'([^']*)')/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(attributesStr)) !== null) {
        attrs[match[1]] = match[2] ?? match[3] ?? '';
    }
    return attrs;
}

export function getInvalidCitationFallbackKeyFromAttrs(rawAttrs: Record<string, string>): string | null {
    const normalized = normalizeCitationTag(rawAttrs);
    if (normalized.ok) return null;
    return normalized.rawIdentity ? `invalid:${normalized.rawIdentity}` : null;
}
