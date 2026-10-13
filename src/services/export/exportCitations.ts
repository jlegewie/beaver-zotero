/**
 * Resolve and format an export's citations in Zotero.
 *
 * Each citation tag is resolved to what it cites (`resolveCitationTarget`,
 * from the citation metadata captured with the source), then to a library
 * item or embedded CSL-JSON, and the whole document is formatted as one
 * citation sequence in the chosen style. Things the citation processor cannot
 * format — attached external files, items no longer in the library — are
 * kept as plain text so no citation silently disappears.
 *
 * Export is a local render of the user's own history, so library exclusions do
 * not gate it (nothing leaves the device).
 */

import {
    formatLocator,
    resolveCitationTarget,
} from '@beaver/agent-export/citations/citationTargets';
import { externalReferenceToCsl } from '@beaver/agent-export/citations/externalCsl';
import { cslHtmlToText } from '@beaver/agent-export/citations/inlineHtml';
import { assignNotePlacements, renderedClusterOrder } from '@beaver/agent-export/citations/noteIndices';
import type {
    CitationOccurrence,
    CitationSnapshot,
    ExportDoc,
    ExportWarning,
    FieldCitationItem,
    FormattedCitations,
    FormattedCluster,
    LocatorSpec,
    NoteCitationItem,
} from '@beaver/agent-export/types';
import { logger } from '@beaver/agent-core/platform/logger';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { resolveLibraryRef } from '../../utils/libraryIdentity';
import { getBestPDFAttachmentAsync } from '../../utils/zoteroItemHelpers';
import type { CitationService, SequenceCitationItem } from '../CitationService';

/** A cited work as the processor sees it. */
type ProcessorItem = {
    kind: 'processor';
    id: number | string;
    uris: string[];
    locator?: string;
    /** CSL locator type (page when absent). */
    label?: string;
    prefix?: string;
    suffix?: string;
    suppressAuthor?: boolean;
};

/** Item metadata a Zotero note stores for its citations (`data-citation-items`). */
export type NoteCitationCacheEntry = { uris: string[]; itemData: Record<string, unknown> };

/** A citation kept as text. */
type TextItem = { kind: 'text'; text: string; unresolved: boolean };

type ResolvedItem = ProcessorItem | TextItem;

export interface FormatExportCitationsOptions {
    styleId?: string;
    locale?: string;
    liveCitations: boolean;
    /** The exported note's stored item metadata, for citations of items no longer in the library. */
    noteCitationItems?: NoteCitationCacheEntry[];
}

export interface FormatExportCitationsResult {
    citations: FormattedCitations;
    warnings: ExportWarning[];
}

/**
 * A stable URI for an external work. Zotero keys embedded items by URI on
 * refresh; with no URI every citation of the work becomes a separate item
 * (disambiguated as 2018a/2018b, numbered twice). The URI never resolves to a
 * library item, so Zotero keeps using the embedded `itemData`.
 */
export function externalReferenceUri(externalId: string, reference: ExternalReference): string {
    const doi = reference.identifiers?.doi;
    if (doi) return `https://doi.org/${doi}`;
    if (reference.source === 'openalex') return `https://openalex.org/${encodeURIComponent(externalId)}`;
    if (reference.source === 'semantic_scholar') return `https://www.semanticscholar.org/paper/${encodeURIComponent(externalId)}`;
    return `urn:beaver:external:${encodeURIComponent(externalId)}`;
}

function fallbackText(name: string, locator?: string): string {
    return `(${name}${locator ? `, p. ${locator}` : ''})`;
}

/** A short stable hash (FNV-1a), to name an embedded work by its identity. */
function stableHash(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

/**
 * The library item a note citation names: by URI, skipping items in the
 * trash and following merges, as Zotero's note editor does.
 */
async function itemFromURIs(uris: string[]): Promise<Zotero.Item | null> {
    const editorInstance = (Zotero as any).EditorInstance;
    if (typeof editorInstance?.getItemFromURIs === 'function') {
        return (await editorInstance.getItemFromURIs(uris)) || null;
    }
    for (const uri of uris) {
        try {
            const item = await Zotero.URI.getURIItem(uri);
            if (item && !item.deleted) return item as Zotero.Item;
        } catch {
            // Not a Zotero URI.
        }
    }
    return null;
}

/** Same work cited with the same notes, so the two are one citation. */
function sameNotes(a: ProcessorItem, b: ProcessorItem): boolean {
    return (a.label ?? 'page') === (b.label ?? 'page')
        && a.prefix === b.prefix
        && a.suffix === b.suffix
        && !!a.suppressAuthor === !!b.suppressAuthor;
}

/** Combine two page locators of one work, without repeating pages. */
export function mergeLocators(first: string | undefined, second: string | undefined): string | undefined {
    if (!first || !second) return first || second;
    const parts = [...first.split(/,\s*/), ...second.split(/,\s*/)].map(part => part.trim()).filter(Boolean);
    return [...new Set(parts)].join(', ');
}

/** The item a citation of `item` should cite: its top-level ancestor. */
async function citableItem(item: Zotero.Item): Promise<Zotero.Item> {
    let current = item;
    // Bounded: annotation → attachment → parent is the deepest chain.
    for (let depth = 0; depth < 4 && current.parentItemID; depth++) {
        const parent = await Zotero.Items.getAsync(current.parentItemID);
        if (!parent) break;
        current = parent as Zotero.Item;
    }
    return current;
}

/** Page labels of the attachment a citation points into. */
async function attachmentPageLabels(
    cited: Zotero.Item,
    top: Zotero.Item,
    snapshot: CitationSnapshot,
): Promise<Record<number, string> | null> {
    let attachmentId: number | null = null;
    if (cited.isAttachment()) attachmentId = cited.id;
    else if (cited.isAnnotation() && cited.parentItemID) attachmentId = cited.parentItemID;
    else attachmentId = (await getBestPDFAttachmentAsync(top))?.id ?? null;
    if (attachmentId == null) return null;
    const labels = snapshot.pageLabelsByAttachmentId[attachmentId];
    return labels && Object.keys(labels).length > 0 ? labels : null;
}

class CitationResolver {
    readonly embeddedItems: Record<string, Record<string, unknown>> = {};
    /** Processor id of each embedded note work, by every URI it was cited with. */
    private readonly embeddedIdByUri = new Map<string, string>();
    unresolved = 0;

    constructor(
        private readonly snapshot: CitationSnapshot,
        private readonly noteCitationItems: NoteCitationCacheEntry[] = [],
    ) {}

    async resolve(occurrence: CitationOccurrence): Promise<ResolvedItem | null> {
        if (occurrence.note) return this.resolveNoteItem(occurrence.note, occurrence.previewText ?? occurrence.groupPreview);
        const target = resolveCitationTarget(occurrence, this.snapshot);
        switch (target.kind) {
            case 'zotero':
                return this.resolveLibraryItem(target);
            case 'external': {
                const locator = target.locator ? formatLocator(target.locator) : undefined;
                if (!target.reference) {
                    return this.unresolvedText(target.displayName, locator);
                }
                // One processor id per work, so repeated citations are recognized as such.
                const id = `beaver-external-${target.externalId.replace(/[^\w.-]/g, '_')}`;
                this.embeddedItems[id] ??= externalReferenceToCsl(target.reference, id);
                return { kind: 'processor', id, uris: [externalReferenceUri(target.externalId, target.reference)], ...(locator ? { locator } : {}) };
            }
            case 'external_file': {
                const locator = target.locator ? formatLocator(target.locator) : undefined;
                return { kind: 'text', text: fallbackText(target.displayName, locator), unresolved: false };
            }
            default:
                return this.unresolvedText(target.displayName);
        }
    }

    /**
     * A cited item of a Zotero note: the library item its URIs name (current
     * metadata), else the metadata the note stores for it (the citation stays
     * a citation when the item was deleted or is in a library this computer
     * no longer has), else what the note shows for it. The locator is a page
     * label as stored, never translated.
     */
    private async resolveNoteItem(note: NoteCitationItem, previewText: string | undefined): Promise<ResolvedItem | null> {
        const notes = {
            ...(note.locator ? { locator: note.locator, ...(note.label ? { label: note.label } : {}) } : {}),
            ...(note.prefix ? { prefix: note.prefix } : {}),
            ...(note.suffix ? { suffix: note.suffix } : {}),
            ...(note.suppressAuthor ? { suppressAuthor: true } : {}),
        };
        try {
            const item = note.uris.length > 0 ? await itemFromURIs(note.uris) : null;
            if (item) {
                const top = await citableItem(item);
                await top.loadAllData();
                if (!top.isNote()) {
                    const uri = Zotero.URI.getItemURI(top);
                    return { kind: 'processor', id: top.id, uris: [uri, ...note.uris.filter(other => other !== uri)], ...notes };
                }
            }
        } catch (error) {
            logger(`exportCitations: could not resolve note citation ${note.uris.join(' ')}: ${error}`, 2);
        }
        const stored = this.noteCitationItems.find(entry => entry.uris.some(uri => note.uris.includes(uri)));
        const itemData = note.itemData ?? stored?.itemData;
        if (itemData) {
            // A work cited under several URIs (merged items) is one work: the
            // citation's URIs and those its stored metadata lists are aliases.
            const aliases = [...new Set([...note.uris, ...(stored?.uris ?? [])])];
            let id = aliases.map(uri => this.embeddedIdByUri.get(uri)).find(Boolean);
            id ??= `note-embedded-${stableHash(aliases[0] ?? JSON.stringify(itemData))}`;
            for (const uri of aliases) this.embeddedIdByUri.set(uri, id);
            this.embeddedItems[id] ??= { ...itemData };
            return { kind: 'processor', id, uris: note.uris.length > 0 ? note.uris : [`urn:beaver:embedded:${id}`], ...notes };
        }
        this.unresolved += 1;
        return previewText ? { kind: 'text', text: previewText, unresolved: true } : null;
    }

    private unresolvedText(displayName: string | undefined, locator?: string): TextItem | null {
        this.unresolved += 1;
        return displayName ? { kind: 'text', text: fallbackText(displayName, locator), unresolved: true } : null;
    }

    private async resolveLibraryItem(target: {
        libraryId: number;
        libraryRef?: string;
        zoteroKey: string;
        locator: LocatorSpec | null;
        displayName?: string;
    }): Promise<ResolvedItem | null> {
        const metadataLocator = target.locator ? formatLocator(target.locator) : undefined;
        const libraryID = resolveLibraryRef({ library_ref: target.libraryRef, library_id: target.libraryId });
        if (!libraryID) return this.unresolvedText(target.displayName, metadataLocator);
        try {
            const cited = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, target.zoteroKey);
            if (!cited) return this.unresolvedText(target.displayName, metadataLocator);
            const top = await citableItem(cited as Zotero.Item);
            await top.loadAllData();
            if (top.isNote()) {
                const title = top.getNoteTitle() || target.displayName || 'Note';
                return { kind: 'text', text: fallbackText(title), unresolved: false };
            }
            let locator = metadataLocator;
            if (target.locator && !target.locator.labels) {
                const labels = await attachmentPageLabels(cited as Zotero.Item, top, this.snapshot);
                if (labels) locator = formatLocator(target.locator, labels);
            }
            return {
                kind: 'processor',
                id: top.id,
                uris: [Zotero.URI.getItemURI(top)],
                ...(locator ? { locator } : {}),
            };
        } catch (error) {
            logger(`exportCitations: could not resolve ${libraryID}/${target.zoteroKey}: ${error}`, 2);
            return this.unresolvedText(target.displayName, metadataLocator);
        }
    }
}

/** Zotero's document preferences for live citations (XML DocumentData). */
function documentPreferences(styleId: string, locale: string, styleClass: 'in-text' | 'note', hasBibliography: boolean): string {
    const DocumentData = (Zotero as any).Integration.DocumentData;
    const data = new DocumentData();
    data.sessionID = Zotero.Utilities.randomString(10);
    data.style = { styleID: styleId, locale, hasBibliography, bibliographyStyleHasBeenSet: true };
    data.prefs = {
        fieldType: 'Field',
        // Footnotes; Zotero omits the pref for in-text styles.
        ...(styleClass === 'note' ? { noteType: 1 } : {}),
        automaticJournalAbbreviations: !!Zotero.Prefs.get('cite.automaticJournalAbbreviations'),
    };
    return data.serialize();
}

/** Resolve and format every citation cluster of the document. */
export async function formatExportCitations(
    doc: ExportDoc,
    snapshot: CitationSnapshot,
    citationService: Pick<CitationService, 'formatCitationSequence' | 'resolveStyle'>,
    options: FormatExportCitationsOptions,
): Promise<FormatExportCitationsResult> {
    // Zotero loads styles lazily; nothing guarantees they are loaded yet.
    if (!Zotero.Styles.initialized()) await Zotero.Styles.init();
    // Metadata a note keeps inline on one citation serves every citation of
    // the work, as the note editor pools it into the note's stored metadata.
    const noteCitationItems = [
        ...(options.noteCitationItems ?? []),
        ...doc.clusters.flatMap(cluster => cluster.items.flatMap(occurrence =>
            (occurrence.note?.itemData ? [{ uris: occurrence.note.uris, itemData: occurrence.note.itemData }] : []))),
    ];
    const resolver = new CitationResolver(snapshot, noteCitationItems);
    const resolved: ResolvedItem[][] = [];
    for (const cluster of doc.clusters) {
        const results: Array<{ occurrence: CitationOccurrence; item: ResolvedItem | null }> = [];
        for (const occurrence of cluster.items) results.push({ occurrence, item: await resolver.resolve(occurrence) });
        // A note citation that shows its items only together: when any of
        // them cannot be resolved, the whole citation is written as the note
        // shows it, rather than its resolved works twice or the others not at all.
        const shownWhole = new Set(results
            .filter(result => result.occurrence.groupPreview && result.item?.kind !== 'processor')
            .map(result => result.occurrence.groupPreview!));
        const items: ResolvedItem[] = [];
        for (const result of results) {
            const group = result.occurrence.groupPreview;
            const item: ResolvedItem | null = group && shownWhole.has(group)
                ? { kind: 'text', text: group, unresolved: true }
                : result.item;
            if (!item) continue;
            if (item.kind === 'text' && items.some(other => other.kind === 'text' && other.text === item.text)) continue;
            // The same work cited twice in one cluster is one citation, with
            // its pages combined ("2012, 3, 8" rather than "2012, 3; 2012, 8").
            const same = item.kind === 'processor'
                ? items.find((other): other is ProcessorItem => other.kind === 'processor' && other.id === item.id && sameNotes(other, item))
                : undefined;
            if (same && item.kind === 'processor') {
                same.locator = mergeLocators(same.locator, item.locator);
                continue;
            }
            items.push(item);
        }
        resolved.push(items);
    }

    const processorItems = (index: number) =>
        resolved[index].filter((item): item is ProcessorItem => item.kind === 'processor');

    const isNoteStyle = citationService.resolveStyle(options.styleId, options.locale).style?.class === 'note';
    const placements = isNoteStyle
        ? assignNotePlacements(doc, index => processorItems(index).length > 0)
        : new Map();

    // The processor sees clusters in the order a reader meets them (a citation
    // in a markdown footnote comes where the footnote is referenced), so
    // numbering and first/subsequent forms follow the written document.
    const order = renderedClusterOrder(doc);
    const sequence = citationService.formatCitationSequence({
        styleId: options.styleId,
        locale: options.locale,
        clusters: order.map(index => ({
            items: processorItems(index).map((item): SequenceCitationItem => ({
                id: item.id,
                ...(item.locator ? { locator: item.locator, label: item.label ?? 'page' } : {}),
                ...(item.prefix ? { prefix: item.prefix } : {}),
                ...(item.suffix ? { suffix: item.suffix } : {}),
                ...(item.suppressAuthor ? { suppressAuthor: true } : {}),
            })),
            noteIndex: placements.get(index)?.noteIndex ?? 0,
        })),
        embeddedItems: resolver.embeddedItems,
    });
    const formattedByCluster = new Map(order.map((clusterIndex, position) => [clusterIndex, sequence.clusters[position]]));

    const clusters: FormattedCluster[] = resolved.map((items, index) => {
        const formatted = formattedByCluster.get(index);
        const html = formatted?.html ?? '';
        const fieldItems: FieldCitationItem[] = processorItems(index).map(item => ({
            id: item.id,
            uris: item.uris,
            itemData: sequence.itemData[String(item.id)] ?? {},
            ...(item.locator ? { locator: item.locator, label: item.label ?? 'page' } : {}),
            ...(item.prefix ? { prefix: item.prefix } : {}),
            ...(item.suffix ? { suffix: item.suffix } : {}),
            ...(item.suppressAuthor ? { suppressAuthor: true } : {}),
        }));
        return {
            html,
            plain: cslHtmlToText(html),
            ...(formatted?.rtf ? { rtf: formatted.rtf } : {}),
            noteIndex: placements.get(index)?.noteIndex ?? 0,
            items: html ? fieldItems : [],
            fallbackTexts: items.filter((item): item is TextItem => item.kind === 'text').map(item => item.text),
        };
    });

    const warnings: ExportWarning[] = [];
    if (options.styleId && sequence.styleId !== options.styleId) {
        warnings.push({
            code: 'style_unavailable',
            message: `The citation style ${options.styleId} is not installed; ${sequence.styleId} was used instead.`,
        });
    }
    if (resolver.unresolved > 0) {
        warnings.push({
            code: 'unresolved_citations',
            message: `${resolver.unresolved} citation${resolver.unresolved === 1 ? '' : 's'} could not be found in your library and ${resolver.unresolved === 1 ? 'was' : 'were'} exported as text or omitted.`,
            count: resolver.unresolved,
        });
    }

    return {
        citations: {
            styleId: sequence.styleId,
            locale: sequence.locale,
            styleClass: sequence.styleClass,
            ...(sequence.citationFormat ? { citationFormat: sequence.citationFormat } : {}),
            clusters,
            bibliography: sequence.bibliography,
            documentData: options.liveCitations
                ? documentPreferences(sequence.styleId, sequence.locale, sequence.styleClass, sequence.hasBibliography)
                : null,
        },
        warnings,
    };
}
