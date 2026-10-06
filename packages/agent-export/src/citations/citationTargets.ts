/**
 * Decide what each citation occurrence points at, from the citation metadata
 * captured with the source.
 *
 * Mirrors how the chat resolves a citation (`useCitationViewModel`): metadata
 * is found by the requested key, then the base key, then the invalid-tag
 * fallback; the resolved identity wins over the requested one; an external
 * reference that was imported into the library cites the library item; and the
 * cited pages come from the metadata, falling back to a page locator written in
 * the tag. Looking items up in a library is left to the host.
 */

import {
    baseCitationKey,
    externalCompatKey,
    getRequestedRef,
    getResolvedRef,
    requestedCitationKey,
    isRecordIdRange,
    type CitationRef,
} from '@beaver/agent-core/citations/citationGrammar';
import { getCitationPages, getContentKind, type Citation } from '@beaver/agent-core/types/citations';
import type { CitationOccurrence, CitationSnapshot, CitationTarget, LocatorSpec } from '../types';

/** Metadata for an occurrence, by the same key precedence the chat uses. */
export function findCitationMetadata(occurrence: CitationOccurrence, snapshot: CitationSnapshot): Citation | undefined {
    const byKey = snapshot.citationsByKey;
    if (occurrence.requestedKey && byKey[occurrence.requestedKey]) return byKey[occurrence.requestedKey];
    if (occurrence.ref) {
        const base = byKey[baseCitationKey(occurrence.ref)];
        if (base) return base;
    }
    return occurrence.invalidKey ? byKey[occurrence.invalidKey] : undefined;
}

/**
 * `metadata` describes exactly this passage (its pages are the cited pages);
 * `workMetadata` is any metadata of the cited work, which still tells what
 * kind of document it is and how its pages are labelled.
 */
function locatorFor(ref: CitationRef, metadata: Citation | undefined, workMetadata: Citation | undefined): LocatorSpec | null {
    const contentKind = workMetadata ? getContentKind(workMetadata) : null;
    // Snapshot "pages" are a navigation coordinate, not something a reader can look up.
    if (contentKind === 'snapshot') return null;
    const labelSource = metadata?.page_labels ?? workMetadata?.page_labels;
    const labels = labelSource && Object.keys(labelSource).length > 0 ? labelSource : null;
    const labelsOnly = contentKind === 'epub';

    const metadataPages = metadata ? getCitationPages(metadata) : [];
    if (metadataPages.length > 0) {
        // A structural span (a sentence range across pages) carries only its end
        // pages; a list that skips pages does not.
        const inclusiveRange = !!ref.loc && isRecordIdRange(ref.loc);
        return { pages: metadataPages, labels, inclusiveRange, labelsOnly };
    }
    if (ref.loc?.kind === 'page' && /\d/.test(ref.loc.value)) {
        const written = ref.loc.value.replace(/[\u2013\u2014]/g, '-').replace(/\s*([,-])\s*/g, (_, sep: string) => (sep === ',' ? ', ' : '-')).trim();
        return { pages: [], labels, inclusiveRange: false, labelsOnly, written };
    }
    return null;
}

/**
 * Whether metadata describes exactly this tag (same work and locator). Lookup
 * maps also file metadata under the bare base key when it is the only
 * citation of a work, and its pages belong to that other passage.
 */
function describesExactly(metadata: Citation, requestedKey: string): boolean {
    if (!requestedKey) return false;
    for (const ref of [getRequestedRef(metadata), getResolvedRef(metadata)]) {
        if (!ref) continue;
        if (requestedCitationKey(ref) === requestedKey) return true;
        if (ref.kind === 'external' && externalCompatKey(ref.external_id, ref.loc) === requestedKey) return true;
    }
    return false;
}

/** What an occurrence cites. */
export function resolveCitationTarget(occurrence: CitationOccurrence, snapshot: CitationSnapshot): CitationTarget {
    const metadata = findCitationMetadata(occurrence, snapshot);
    if (metadata?.invalid) return { kind: 'unresolved', displayName: metadata.display_name };

    const resolved = (metadata ? getResolvedRef(metadata) : null) ?? occurrence.ref;
    if (!resolved) return { kind: 'unresolved', displayName: metadata?.display_name };
    // The locator is the one written in this tag; metadata keyed by the base key
    // may describe a different passage of the same work.
    const locatorRef: CitationRef = occurrence.ref ?? resolved;
    // Metadata found under a key that carries this tag's locator is exact (such
    // keys never alias); otherwise its own identity must name this tag.
    const foundByLocatorKey = !!occurrence.ref?.loc && snapshot.citationsByKey[occurrence.requestedKey] === metadata;
    const pageMetadata = metadata && (foundByLocatorKey || describesExactly(metadata, occurrence.requestedKey))
        ? metadata
        : undefined;
    const locator = locatorFor(locatorRef, pageMetadata, metadata);
    const displayName = metadata?.display_name || undefined;

    if (resolved.kind === 'external') {
        const mapped = snapshot.externalItemMapping[resolved.external_id];
        if (mapped) {
            return {
                kind: 'zotero',
                libraryId: mapped.library_id,
                ...(mapped.library_ref ? { libraryRef: mapped.library_ref } : {}),
                zoteroKey: mapped.zotero_key,
                locator,
                displayName,
            };
        }
        return {
            kind: 'external',
            externalId: resolved.external_id,
            reference: snapshot.externalReferences[resolved.external_id] ?? null,
            locator,
            displayName,
        };
    }
    if (resolved.kind === 'external_file') {
        return {
            kind: 'external_file',
            extKey: resolved.ext_key,
            displayName: displayName || `ext-${resolved.ext_key}`,
            locator,
        };
    }
    if (resolved.kind === 'zotero') {
        return {
            kind: 'zotero',
            libraryId: resolved.library_id,
            ...(resolved.library_ref ? { libraryRef: resolved.library_ref } : {}),
            zoteroKey: resolved.zotero_key,
            locator,
            displayName,
        };
    }
    return { kind: 'unresolved', displayName };
}

/**
 * Format a locator as the page string a reader looks up: printed page labels
 * when known, compact ranges (`12-15, 18`). `labels` overrides the metadata's.
 * Returns undefined when there is nothing to show.
 */
export function formatLocator(spec: LocatorSpec, labels?: Record<number, string> | null): string | undefined {
    const pageLabels = labels ?? spec.labels;
    if (spec.written) {
        // Labels-only documents (EPUB section ordinals) show nothing without a printed label.
        let unlabelled = false;
        const written = spec.written.replace(/\d+/g, number => {
            const label = pageLabels?.[Number(number) - 1]?.trim();
            if (!label) unlabelled = true;
            return label || number;
        });
        return spec.labelsOnly && unlabelled ? undefined : written;
    }
    const labelOf = (page: number): string | undefined => {
        const label = pageLabels?.[page - 1]?.trim();
        if (label) return label;
        return spec.labelsOnly ? undefined : String(page);
    };
    const pages = spec.pages.filter(page => labelOf(page) !== undefined);
    if (pages.length === 0) return undefined;
    if (spec.inclusiveRange && pages.length > 1) {
        return `${labelOf(pages[0])}-${labelOf(pages[pages.length - 1])}`;
    }
    const ranges: string[] = [];
    for (let i = 0; i < pages.length; i++) {
        const start = pages[i];
        let end = start;
        while (pages[i + 1] === end + 1 && consecutiveLabels(labelOf(end), labelOf(end + 1))) end = pages[++i];
        ranges.push(start === end ? labelOf(start)! : `${labelOf(start)}-${labelOf(end)}`);
    }
    return ranges.join(', ');
}

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** The value of a Roman numeral label (`xiv` → 14), or null. */
function romanValue(label: string): number | null {
    const lower = label.toLowerCase();
    if (!/^[ivxlcdm]+$/.test(lower)) return null;
    let total = 0;
    for (let i = 0; i < lower.length; i++) {
        const value = ROMAN_VALUES[lower[i]];
        const next = ROMAN_VALUES[lower[i + 1]] ?? 0;
        total += value < next ? -value : value;
    }
    return total > 0 ? total : null;
}

/**
 * Whether label `b` directly follows label `a` in one numbering sequence, so
 * a range between them names no pages that are not cited (`10`→`11`,
 * `iv`→`v`; not `10`→`12` or `iv`→`S1`).
 */
function consecutiveLabels(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(b) === Number(a) + 1;
    const romanA = romanValue(a);
    const romanB = romanValue(b);
    return romanA !== null && romanB !== null && romanB === romanA + 1;
}
