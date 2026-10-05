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
};

/** A citation kept as text. */
type TextItem = { kind: 'text'; text: string; unresolved: boolean };

type ResolvedItem = ProcessorItem | TextItem;

export interface FormatExportCitationsOptions {
    styleId?: string;
    locale?: string;
    liveCitations: boolean;
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
    unresolved = 0;

    constructor(private readonly snapshot: CitationSnapshot) {}

    async resolve(occurrence: CitationOccurrence): Promise<ResolvedItem | null> {
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
    const resolver = new CitationResolver(snapshot);
    const resolved: ResolvedItem[][] = [];
    for (const cluster of doc.clusters) {
        const items: ResolvedItem[] = [];
        for (const occurrence of cluster.items) {
            const item = await resolver.resolve(occurrence);
            if (!item) continue;
            // The same work cited twice in one cluster is one citation, with
            // its pages combined ("2012, 3, 8" rather than "2012, 3; 2012, 8").
            const same = item.kind === 'processor'
                ? items.find((other): other is ProcessorItem => other.kind === 'processor' && other.id === item.id)
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
                ...(item.locator ? { locator: item.locator, label: 'page' } : {}),
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
            ...(item.locator ? { locator: item.locator, label: 'page' } : {}),
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
            clusters,
            bibliography: sequence.bibliography,
            documentData: options.liveCitations
                ? documentPreferences(sequence.styleId, sequence.locale, sequence.styleClass, sequence.hasBibliography)
                : null,
        },
        warnings,
    };
}
