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
import { labelsSpanPages } from '@beaver/agent-core/extract/pageLabels/printedPageLabels';
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

function hasPrintedLabel(labels: Record<number, string> | undefined): labels is Record<number, string> {
    return !!labels && Object.values(labels).some(label => typeof label === 'string' && label.trim() !== '');
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
    // A map whose labels are all empty says nothing, so it leaves the caller
    // free to fall back to the attachment's labels.
    const labels = [metadata?.page_labels, workMetadata?.page_labels].find(hasPrintedLabel) ?? null;
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
        const labelOfNumber = (number: string) => pageLabels?.[Number(number) - 1]?.trim() || undefined;
        const written = spec.written.replace(/(\d+)-(\d+)|\d+/g, (match, start?: string, end?: string) => {
            if (start === undefined || end === undefined) {
                const label = labelOfNumber(match);
                if (!label) unlabelled = true;
                return label || match;
            }
            const first = labelOfNumber(start);
            const last = labelOfNumber(end);
            if (!first && !last) {
                unlabelled = true;
                return match;
            }
            if (labelsSpanPages(first, last, Number(end) - Number(start))) return `${first}-${last}`;
            // The ends are not one printed sequence (an unnumbered cover, a
            // gap, two numberings): cite a printed end rather than mix
            // printed and physical numbers in one range.
            return first ?? last!;
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
        const first = pages[0];
        const last = pages[pages.length - 1];
        const printedFirst = pageLabels?.[first - 1]?.trim() || undefined;
        const printedLast = pageLabels?.[last - 1]?.trim() || undefined;
        if (!printedFirst && !printedLast) return `${first}-${last}`;
        // Only a range whose labels span exactly the cited pages; otherwise
        // (an unnumbered end, a gap, two numberings) cite a printed end
        // rather than mix printed and physical numbers.
        return labelsSpanPages(printedFirst, printedLast, last - first)
            ? `${printedFirst}-${printedLast}`
            : printedFirst ?? printedLast;
    }
    // A page list with any printed label cites printed labels only: an
    // unlabelled page is left out rather than shown as a physical number that
    // reads as a printed one ("12, 12").
    const printedPages = pages.filter(page => pageLabels?.[page - 1]?.trim());
    const listed = printedPages.length > 0 ? printedPages : pages;
    const ranges: string[] = [];
    for (let i = 0; i < listed.length; i++) {
        const start = listed[i];
        let end = start;
        while (listed[i + 1] === end + 1 && consecutiveLabels(labelOf(end), labelOf(end + 1))) end = listed[++i];
        ranges.push(start === end ? labelOf(start)! : `${labelOf(start)}-${labelOf(end)}`);
    }
    return ranges.join(', ');
}

/**
 * Whether label `b` directly follows label `a` in one numbering sequence, so
 * a range between them names no pages that are not cited (`10`→`11`,
 * `iv`→`v`; not `10`→`12` or `iv`→`S1`).
 */
function consecutiveLabels(a: string | undefined, b: string | undefined): boolean {
    return labelsSpanPages(a, b, 1);
}
