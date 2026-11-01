/**
 * External records: id grammar, snapshot ordering and snapshot combination.
 *
 * The same external id can arrive from several sources (an OpenAlex search
 * and a PubMed search both return a W-id) and repeatedly from the same one.
 * A snapshot is one `ExternalReference` exactly as a single source returned
 * it. Consumers read the combination of the latest snapshot per source.
 *
 * Mirrors the backend's `app/external_sources/ids.py` and `combine.py`; both
 * are checked against the same golden files, so keep them in step.
 */

import type {
    ExternalReference,
    ExternalReferenceDetails,
    WorkDetails,
} from '../types/externalReferences';
import { trialDetails, workDetails } from '../types/externalReferences';

// =============================================================================
// Id grammar
// =============================================================================

export type ExternalIdNamespace = 'openalex' | 'openlibrary' | 'isbn' | 'doi' | 'pmid' | 'nct';

const ID_PATTERNS: Array<[ExternalIdNamespace, RegExp]> = [
    ['openalex', /^[Ww](\d+)$/],
    ['openlibrary', /^openlibrary:(OL\d+[A-Za-z])$/i],
    ['isbn', /^isbn:([\dXx]{10}|\d{13})$/i],
    ['doi', /^doi:(10\.\S+)$/i],
    ['pmid', /^pmid:(\d+)$/i],
    ['nct', /^(NCT\d{8})$/i],
];

/** The namespace an external id belongs to, or null for ids outside the grammar. */
export function externalIdNamespace(externalId: string | null | undefined): ExternalIdNamespace | null {
    if (typeof externalId !== 'string') return null;
    const value = externalId.trim();
    for (const [namespace, pattern] of ID_PATTERNS) {
        if (pattern.test(value)) return namespace;
    }
    return null;
}

/** Whether the id is an OpenAlex work id (`W…`). */
export function isOpenAlexWorkId(externalId: string | null | undefined): boolean {
    return externalIdNamespace(externalId) === 'openalex';
}

/** The PubMed id inside a `pmid:N` id, or null. */
export function pmidFromExternalId(externalId: string | null | undefined): string | null {
    const match = typeof externalId === 'string' ? /^pmid:(\d+)$/i.exec(externalId.trim()) : null;
    return match ? String(Number(match[1])) : null;
}

/** The uppercase NCT id when the id is a trial registration, or null. */
export function nctFromExternalId(externalId: string | null | undefined): string | null {
    const match = typeof externalId === 'string' ? /^(NCT\d{8})$/i.exec(externalId.trim()) : null;
    return match ? match[1].toUpperCase() : null;
}

/** The source that natively supplies ids of a namespace. */
const SUPPLIER_BY_NAMESPACE: Record<ExternalIdNamespace, string> = {
    openalex: 'openalex',
    openlibrary: 'openlibrary',
    isbn: 'openlibrary',
    doi: 'crossref',
    pmid: 'pubmed',
    nct: 'clinicaltrials',
};

/** The source that natively supplies an id, or null for ids outside the grammar. */
export function supplierForExternalId(externalId: string | null | undefined): string | null {
    const namespace = externalIdNamespace(externalId);
    return namespace ? SUPPLIER_BY_NAMESPACE[namespace] : null;
}

// =============================================================================
// Timestamps
// =============================================================================

/**
 * A comparable form of an ISO timestamp: epoch seconds plus the fraction in
 * nanoseconds, so microsecond-precise backend timestamps compare exactly
 * (a JS Date keeps only milliseconds). Null when unset or unparsable.
 */
function timestampKey(value: string | null | undefined): [number, number] | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const match = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)?$/i.exec(value.trim());
    if (match) {
        const zone = match[3] ? match[3].replace(/^([+-]\d\d)(\d\d)$/, '$1:$2') : 'Z';
        const seconds = Date.parse(`${match[1].replace(' ', 'T')}${zone.toUpperCase()}`);
        if (Number.isNaN(seconds)) return null;
        const fraction = Number((match[2] ?? '').padEnd(9, '0').slice(0, 9));
        return [seconds / 1000, fraction];
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : [Math.floor(parsed / 1000), (parsed % 1000) * 1e6];
}

/** Compare two timestamps: negative, zero or positive. Both must be set. */
function compareKeys(a: [number, number], b: [number, number]): number {
    return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** Whether `a` is strictly later than `b`; an unset timestamp is never later. */
export function isLaterTimestamp(a: string | null | undefined, b: string | null | undefined): boolean {
    const keyA = timestampKey(a);
    if (!keyA) return false;
    const keyB = timestampKey(b);
    return !keyB || compareKeys(keyA, keyB) > 0;
}

// =============================================================================
// Snapshot ordering
// =============================================================================

/**
 * Whether `incoming` replaces `stored` as its source's latest snapshot.
 *
 * A timestamped snapshot beats an untimestamped one; among timestamped
 * snapshots a strictly newer `retrieved_at` wins and an equal one keeps the
 * stored snapshot; between untimestamped snapshots the later arrival wins.
 */
export function replacesSnapshot(stored: ExternalReference, incoming: ExternalReference): boolean {
    const incomingKey = timestampKey(incoming.retrieved_at);
    const storedKey = timestampKey(stored.retrieved_at);
    if (!incomingKey) return !storedKey;
    if (!storedKey) return true;
    return compareKeys(incomingKey, storedKey) > 0;
}

/**
 * `kept`, carrying `other`'s library check when that check is newer.
 *
 * Library state is not source data: a re-check of the same snapshot, or a
 * check that ran on an older snapshot of the same source, must survive when
 * snapshots are ordered by `retrieved_at`. Returns a copy when the library
 * state changes; snapshots are never mutated.
 */
export function keepNewerLibraryState(kept: ExternalReference, other: ExternalReference): ExternalReference {
    const otherChecked = timestampKey(other.library_checked_at);
    const keptChecked = timestampKey(kept.library_checked_at);
    if (!otherChecked || (keptChecked && compareKeys(keptChecked, otherChecked) >= 0)) return kept;
    return {
        ...kept,
        library_items: [...(other.library_items ?? [])],
        library_checked_at: other.library_checked_at,
    };
}

/**
 * Relabel an untimestamped `openalex` record whose id names another supplier.
 *
 * Open Library and Crossref records were once stored as `source="openalex"`;
 * read as OpenAlex snapshots they would outrank those sources' own newer
 * snapshots. Timestamped OpenAlex snapshots of such ids are real OpenAlex
 * data and keep their label.
 */
export function withSupplierSource(reference: ExternalReference): ExternalReference {
    if (reference.source !== 'openalex' || timestampKey(reference.retrieved_at)) return reference;
    const supplier = supplierForExternalId(reference.source_id);
    if (!supplier || supplier === 'openalex') return reference;
    return { ...reference, source: supplier };
}

/** Snapshots of one id, keyed by source. */
export type SnapshotsBySource = Record<string, ExternalReference>;

/**
 * Store one snapshot among its id's snapshots by the ordering rule.
 * Returns the updated map, or null when nothing changed. Never mutates.
 */
export function ingestSnapshot(
    stored: SnapshotsBySource | undefined,
    incoming: ExternalReference,
): SnapshotsBySource | null {
    const reference = withSupplierSource(incoming);
    const source = reference.source ?? '';
    const current = stored?.[source];
    let next: ExternalReference;
    if (!current) {
        next = reference;
    } else if (replacesSnapshot(current, reference)) {
        next = keepNewerLibraryState(reference, current);
    } else {
        next = keepNewerLibraryState(current, reference);
        if (next === current) return null;
    }
    return { ...(stored ?? {}), [source]: next };
}

/**
 * The combined record of each id in `snapshots` (a tool's `references` plus
 * its `extra_snapshots`), in first-seen order.
 */
export function combineSnapshotList(snapshots: ExternalReference[]): Map<string, ExternalReference> {
    const bySource = new Map<string, SnapshotsBySource>();
    for (const snapshot of snapshots) {
        const id = snapshot?.source_id;
        if (!id) continue;
        const updated = ingestSnapshot(bySource.get(id), snapshot);
        if (updated) bySource.set(id, updated);
    }
    const combined = new Map<string, ExternalReference>();
    for (const [id, sources] of bySource) combined.set(id, combineSnapshots(Object.values(sources)));
    return combined;
}

// =============================================================================
// Combination
// =============================================================================

/** Precedence for bibliographic groups; sources not listed rank below, by name. */
export const SOURCE_PRECEDENCE = ['pubmed', 'openalex', 'crossref', 'openlibrary'] as const;

function comparePrecedence(a: ExternalReference, b: ExternalReference): number {
    const rank = (source: string) => {
        const index = (SOURCE_PRECEDENCE as readonly string[]).indexOf(source);
        return index >= 0 ? index : SOURCE_PRECEDENCE.length;
    };
    const difference = rank(a.source) - rank(b.source);
    if (difference !== 0) return difference;
    const nameA = rank(a.source) < SOURCE_PRECEDENCE.length ? '' : a.source ?? '';
    const nameB = rank(b.source) < SOURCE_PRECEDENCE.length ? '' : b.source ?? '';
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
}

type Field = keyof ExternalReference;

/** A field is present when it is neither null nor undefined: false, 0 and [] are values. */
function has(snapshot: ExternalReference, ...fields: Field[]): boolean {
    return fields.some((name) => snapshot[name] !== null && snapshot[name] !== undefined);
}

function first(
    ordered: ExternalReference[],
    predicate: (snapshot: ExternalReference) => boolean,
): ExternalReference | undefined {
    return ordered.find(predicate);
}

function isUnknownDetails(details: ExternalReferenceDetails | null | undefined): boolean {
    return !!details && typeof details === 'object' && details.kind !== 'work' && details.kind !== 'trial';
}

/**
 * The record for one id, derived from its snapshots (at most one per source).
 *
 * Fields are chosen in groups, and a group always comes whole from one
 * snapshot, so a combined record is never internally inconsistent (an author
 * list never pairs with another source's creators, a year never with another
 * source's date). Pure.
 */
export function combineSnapshots(snapshots: ExternalReference[]): ExternalReference {
    const ordered = [...snapshots].sort(comparePrecedence);
    if (ordered.length === 0) throw new Error('combineSnapshots needs at least one snapshot');
    if (ordered.length === 1) return ordered[0];

    const primary = ordered[0];
    const data: Record<string, unknown> = {
        id: primary.id,
        source: primary.source,
        source_id: primary.source_id,
    };
    const take = (fields: Field[], snapshot: ExternalReference | undefined) => {
        for (const name of fields) data[name] = snapshot ? snapshot[name] : undefined;
    };

    take(['title'], first(ordered, (s) => has(s, 'title')));
    take(['creators', 'authors'], first(ordered, (s) => has(s, 'creators', 'authors')));
    take(['publication_date', 'year'], first(ordered, (s) => has(s, 'publication_date', 'year')));
    take(['journal', 'venue'], first(ordered, (s) => has(s, 'journal', 'venue')));
    take(['item_type', 'zotero_fields', 'publication_types', 'raw_publication_types'], first(ordered, (s) =>
        has(s, 'item_type', 'publication_types', 'raw_publication_types')
        || Object.keys(s.zotero_fields ?? {}).length > 0));
    for (const name of ['url', 'publication_url', 'fields_of_study'] as Field[]) {
        take([name], first(ordered, (s) => has(s, name)));
    }

    const openalex = ordered.find((s) => s.source === 'openalex');
    const metrics: Field[] = ['citation_count', 'influential_citation_count', 'reference_count'];
    take(metrics, openalex ?? first(ordered, (s) => has(s, ...metrics)));
    take(['oa_candidates', 'open_access_url', 'is_open_access'], openalex ?? primary);

    // Identifiers: per identifier, the highest-precedence snapshot that has it.
    const identifiers: Record<string, string> = {};
    for (const snapshot of ordered) {
        for (const [name, value] of Object.entries(snapshot.identifiers ?? {})) {
            if (value !== null && value !== undefined && !(name in identifiers)) identifiers[name] = value;
        }
    }
    data.identifiers = Object.keys(identifiers).length ? identifiers : undefined;

    const retracted = ordered
        .map((s) => s.is_retracted)
        .filter((value): value is boolean => value !== null && value !== undefined);
    data.is_retracted = retracted.includes(true) ? true : retracted[0];

    // Library: the newest check wins; unchecked snapshots count only when no
    // snapshot was checked (records stored before checks were timestamped).
    let newestCheck: ExternalReference | undefined;
    for (const snapshot of ordered) {
        if (!timestampKey(snapshot.library_checked_at)) continue;
        if (!newestCheck || isLaterTimestamp(snapshot.library_checked_at, newestCheck.library_checked_at)) {
            newestCheck = snapshot;
        }
    }
    if (newestCheck) {
        data.library_items = [...(newestCheck.library_items ?? [])];
        data.library_checked_at = newestCheck.library_checked_at;
    } else {
        const holder = first(ordered, (s) => (s.library_items?.length ?? 0) > 0);
        data.library_items = holder ? [...holder.library_items] : [];
    }

    let newest: string | null | undefined;
    for (const snapshot of ordered) {
        if (isLaterTimestamp(snapshot.retrieved_at, newest)) newest = snapshot.retrieved_at;
    }
    data.retrieved_at = newest ?? undefined;

    // Abstract group: the abstract and its structured sections travel together.
    const abstractHolder = first(ordered, (s) => has(s, 'abstract'));
    data.abstract = abstractHolder?.abstract;
    data.details = combinedDetails(ordered, abstractHolder);

    for (const key of Object.keys(data)) {
        if (data[key] === undefined) delete data[key];
    }
    return data as unknown as ExternalReference;
}

function combinedDetails(
    ordered: ExternalReference[],
    abstractHolder: ExternalReference | undefined,
): ExternalReferenceDetails | undefined {
    const trial = ordered.map(trialDetails).find(Boolean);
    if (trial) return trial;
    const workHolder = first(ordered, (s) => !!workDetails(s));
    const abstractDetails = abstractHolder ? workDetails(abstractHolder) : null;
    if (workHolder || abstractDetails) {
        const work = workHolder ? workDetails(workHolder) : null;
        const combined: WorkDetails = {
            kind: 'work',
            abstract_sections: abstractDetails?.abstract_sections ?? null,
            mesh: work?.mesh ?? null,
            pmc_free_after: work?.pmc_free_after ?? null,
        };
        return combined;
    }
    return ordered.map((s) => s.details).find(isUnknownDetails) ?? undefined;
}
