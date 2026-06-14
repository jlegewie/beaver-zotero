import { atom } from 'jotai';
import { logger } from '../../src/utils/logger';
import {
    Citation,
    isExternalCitation,
    getCitationPages,
} from '../types/citations';
import {
    baseCitationKey,
    type CitationRef,
    externalCompatKey,
    getRequestedRef,
    getResolvedRef,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
} from '../utils/citationGrammar';
import { getPref, setPref } from '../../src/utils/prefs';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { isFirstRunVisibleAtom } from './firstRun';
import { activeRunAtom, threadRunsAtom } from '../agents/atoms';
import { isFirstRunOrigin } from '../agents/types';

/**
 * Thread-scoped citation marker assignment.
 *
 * Maps citation keys to numeric markers (e.g., "1", "2", "3").
 * This ensures consistent markers across streaming and post-metadata states:
 * - Markers are assigned in render order during streaming (first appearance = "1")
 * - Same citation key always gets the same marker
 * - Resets when thread changes (via resetCitationMarkersAtom)
 */
export const citationKeyToMarkerAtom = atom<Record<string, string>>({});

function getNextCitationMarker(current: Record<string, string>): string {
    const maxMarker = Object.values(current).reduce((max, marker) => {
        const parsed = parseInt(marker, 10);
        return Number.isFinite(parsed) && parsed > max ? parsed : max;
    }, 0);
    return (maxMarker + 1).toString();
}

function getEarliestExistingMarker(current: Record<string, string>, keys: string[]): string | undefined {
    const markers = keys
        .map((key) => current[key])
        .filter((marker): marker is string => !!marker);
    if (markers.length === 0) return undefined;

    const numericMarkers = markers
        .map((marker) => parseInt(marker, 10))
        .filter((marker) => Number.isFinite(marker));
    if (numericMarkers.length === 0) return markers[0];

    return Math.min(...numericMarkers).toString();
}

/**
 * Get or assign a numeric marker for a citation key.
 * Returns the existing marker if already assigned, otherwise assigns the next number.
 */
export const getOrAssignCitationMarkerAtom = atom(
    null,
    (get, set, citationKey: string): string => {
        const current = get(citationKeyToMarkerAtom);
        if (current[citationKey]) {
            return current[citationKey];
        }
        const nextMarker = getNextCitationMarker(current);
        set(citationKeyToMarkerAtom, { ...current, [citationKey]: nextMarker });
        return nextMarker;
    }
);

/**
 * Lookup a citation marker without assigning (read-only).
 * Returns undefined if the citation key hasn't been assigned a marker yet.
 */
export const getCitationMarkerAtom = atom(
    (get) => (citationKey: string): string | undefined => {
        return get(citationKeyToMarkerAtom)[citationKey];
    }
);

/**
 * Ensure a group of citation base keys all resolve to the same marker.
 */
export const aliasCitationMarkerKeysAtom = atom(
    null,
    (get, set, keys: string[]): string | null => {
        const uniqueKeys = [...new Set(keys.filter(Boolean))];
        if (uniqueKeys.length === 0) return null;

        const current = get(citationKeyToMarkerAtom);
        const existingMarker = getEarliestExistingMarker(current, uniqueKeys);
        const marker = existingMarker || getNextCitationMarker(current);
        const next = { ...current };
        for (const key of uniqueKeys) {
            next[key] = marker;
        }
        set(citationKeyToMarkerAtom, next);
        return marker;
    }
);

/**
 * PDF page labels keyed by Zotero attachment item ID, then 0-based page index.
 */
export type PageLabelsByAttachmentId = Record<number, Record<number, string>>;

export const pageLabelsByAttachmentIdAtom = atom<PageLabelsByAttachmentId>({});

/**
 * Reset citation markers and thread-scoped page-label render state. Called when
 * creating a new thread or loading an existing one.
 */
export const resetCitationMarkersAtom = atom(
    null,
    (_get, set) => {
        set(citationKeyToMarkerAtom, {});
        set(pageLabelsByAttachmentIdAtom, {});
    }
);

export const mergePageLabelsByAttachmentIdAtom = atom(
    null,
    (get, set, labelsByAttachmentId: PageLabelsByAttachmentId) => {
        const entries = Object.entries(labelsByAttachmentId).filter(([, labels]) => (
            labels && Object.keys(labels).length > 0
        ));
        if (entries.length === 0) return;

        const current = get(pageLabelsByAttachmentIdAtom);
        const next: PageLabelsByAttachmentId = { ...current };
        let changed = false;

        for (const [attachmentId, labels] of entries) {
            const id = Number(attachmentId);
            const existing = current[id];
            if (existing && JSON.stringify(existing) === JSON.stringify(labels)) continue;
            next[id] = { ...labels };
            changed = true;
        }

        if (changed) {
            set(pageLabelsByAttachmentIdAtom, next);
        }
    }
);


/*
 * Citations
 *
 * citationsAtom holds all citations for the current thread (run_id stamped
 * client-side at the entry points). Populated by (a) WSRunCompleteEvent
 * citations during streaming and (b) run metadata citations on thread load.
 *
 * Citations arrive render-ready from the backend (citation v2): the lookup
 * maps below are pure derivations — no Zotero item loading happens here.
 */
export const citationsAtom = atom<Citation[]>([]);


/**
 * Citations by run ID — for the assistant message footer.
 */
export const citationsByRunIdAtom = atom<Record<string, Citation[]>>(
    (get) => {
        const citations = get(citationsAtom);
        const citationsByRunId: Record<string, Citation[]> = {};
        for (const citation of citations) {
            const runId = citation.run_id ?? '';
            if (!citationsByRunId[runId]) {
                citationsByRunId[runId] = [];
            }
            citationsByRunId[runId].push(citation);
        }
        return citationsByRunId;
    }
);


/**
 * Citations by citation_id.
 */
export const citationMapAtom = atom<Record<string, Citation>>((get) => {
    const map: Record<string, Citation> = {};
    for (const citation of get(citationsAtom)) {
        map[citation.citation_id] = citation;
    }
    return map;
});

/**
 * Extract the identifier value from a raw citation tag for fallback lookup.
 * This is used for invalid citations where the identity couldn't be parsed.
 *
 * @param rawTag The original citation tag, e.g., '<citation att_id="garbage"/>'
 * @returns Fallback key like "invalid:garbage" or null if no ID found
 */
function getInvalidCitationFallbackKey(rawTag: string): string | null {
    const match = rawTag.match(/^<citation\b([^>]*)/i);
    if (!match) return null;
    const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
    return !normalized.ok && normalized.rawIdentity ? `invalid:${normalized.rawIdentity}` : null;
}

function addCitationKeys(keys: Set<string>, citation: Citation) {
    for (const ref of [getRequestedRef(citation), getResolvedRef(citation)]) {
        if (!ref) continue;
        keys.add(requestedCitationKey(ref));
        if (ref.kind === 'external') {
            keys.add(externalCompatKey(ref.external_id, ref.loc));
        }
    }

    if (citation.raw_tag) {
        const match = citation.raw_tag.match(/^<citation\b([^>]*)/i);
        if (match) {
            const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1] || ''));
            if (normalized.ok) {
                keys.add(requestedCitationKey(normalized.ref));
                if (normalized.ref.kind === 'external') {
                    keys.add(externalCompatKey(normalized.ref.external_id, normalized.ref.loc));
                }
            } else if (normalized.rawIdentity) {
                // The written attribute disagrees with the resolved type, e.g. the
                // model cited an external reference with id="W..." instead of
                // external_id="W...".
                keys.add(`invalid:${normalized.rawIdentity}`);
            }
        }
    }
}

export function getCitationMarkerBaseKeys(citation: Citation): string[] {
    const keys: string[] = [];
    for (const ref of [getRequestedRef(citation), getResolvedRef(citation)]) {
        if (!ref) continue;
        keys.push(baseCitationKey(ref));
        if (ref.kind === 'external') keys.push(externalCompatKey(ref.external_id));
    }
    return [...new Set(keys.filter(Boolean))];
}

function getDisplayRef(citation: Citation): CitationRef | null {
    return getResolvedRef(citation) ?? getRequestedRef(citation);
}

/**
 * Citations mapped by full citation key for lookup.
 *
 * This is the primary lookup mechanism for Citation components:
 * - MarkdownRenderer injects data-requested-citation-key during preprocessing
 * - Citation looks up metadata using this key
 * - Key includes loc/page for unique identification of citation instances
 *
 * Key format:
 * - Zotero citations: "zotero:{library_id}-{zotero_key}" or with location: "zotero:1-ABC:sid=s0-s8"
 * - Structured-document locators use the raw token, e.g. "zotero:1-ABC:heading3"
 * - External citations: "external:{external_source_id}" or with location
 * - External files: "extfile:{ext_key}" or with location
 * - Invalid citations (fallback): "invalid:{raw_id_value}"
 */
export const citationByKeyAtom = atom<Record<string, Citation>>((get) => {
    const citations = get(citationsAtom);
    const byKey: Record<string, Citation> = {};
    const baseCandidates = new Map<string, Citation>();
    const ambiguousBaseKeys = new Set<string>();

    for (const citation of citations) {
        const keys = new Set<string>();
        addCitationKeys(keys, citation);
        for (const key of keys) {
            byKey[key] = citation;
        }

        for (const ref of [getRequestedRef(citation), getResolvedRef(citation)]) {
            if (!ref) continue;
            const baseKeys = ref.kind === 'external'
                ? [baseCitationKey(ref), externalCompatKey(ref.external_id)]
                : [baseCitationKey(ref)];
            for (const baseKey of baseKeys) {
                const existing = baseCandidates.get(baseKey);
                if (existing && existing.citation_id !== citation.citation_id) {
                    ambiguousBaseKeys.add(baseKey);
                } else {
                    baseCandidates.set(baseKey, citation);
                }
            }
        }

        if (citation.invalid && citation.raw_tag) {
            const fallbackKey = getInvalidCitationFallbackKey(citation.raw_tag);
            if (fallbackKey) {
                byKey[fallbackKey] = citation;
            }
        }
    }

    for (const [baseKey, citation] of baseCandidates) {
        if (!ambiguousBaseKeys.has(baseKey) && !byKey[baseKey]) {
            byKey[baseKey] = citation;
        }
    }

    return byKey;
});

/**
 * One-time citation tip: shown when the first external or page-locator citation
 * is processed. Persistent pref ensures it fires at most once.
 *
 * Suppressed without setting the pref while: (1) FirstRunPage is visible, or
 * (2) the active thread is a first-run thread (any run carries a first-run
 * origin — `first_run_card` or `first_run_followup`). Avoids overlapping the
 * citation popup with the NextStepsPanel / BackToSuggestions panels.
 */
function maybeTriggerCitationTip(get: (...args: any[]) => any, set: (...args: any[]) => any) {
    if (get(isFirstRunVisibleAtom)) return;
    const activeRun = get(activeRunAtom);
    const threadRuns = get(threadRunsAtom);
    const isFirstRunThread =
        isFirstRunOrigin(activeRun?.user_prompt?.origin) ||
        threadRuns.some((r: any) => isFirstRunOrigin(r.user_prompt?.origin));
    if (isFirstRunThread) return;
    if (getPref('onboardingCitationTipShown')) return;
    setPref('onboardingCitationTipShown', true);

    set(addPopupMessageAtom, {
        type: 'citation_tip' as const,
        title: 'Understanding Citations',
        expire: false,
    });
}

/**
 * Synchronous post-processing after citations enter the thread state:
 * assigns thread-scoped numeric markers (in list order, aliasing requested
 * and resolved identities to one marker) and fires the one-time citation tip.
 *
 * Call after writing citationsAtom on thread load and run completion. This
 * replaced the async Zotero-enrichment atom — citations now arrive
 * render-ready from the backend.
 */
export const processCitationsAtom = atom(
    null,
    (get, set) => {
        const citations = get(citationsAtom);
        logger(`processCitationsAtom: Processing ${citations.length} citations`);

        let tipTriggered = false;
        for (const citation of citations) {
            if (!citation.invalid) {
                set(aliasCitationMarkerKeysAtom, getCitationMarkerBaseKeys(citation));
            }
            if (
                !tipTriggered
                && (isExternalCitation(citation) || getCitationPages(citation).length > 0)
            ) {
                maybeTriggerCitationTip(get, set);
                tipTriggered = true;
            }
        }
    }
);

export { getDisplayRef };
