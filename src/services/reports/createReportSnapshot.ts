/**
 * Creates a Zotero snapshot attachment from a generated report.
 *
 * The report is stored as a `text/html` file attachment, which Zotero treats as a
 * snapshot: it opens in the reader, is full-text indexed, can be annotated, and
 * syncs like any other stored file. `Zotero.Attachments.importFromSnapshotContent`
 * is the same path the connector uses to save single-file page captures.
 */

import { logger } from '../../utils/logger';
import { getZoteroSelectURI } from '../../utils/zoteroUtils';
import { checkLibraryExcluded } from '../agentDataProvider/utils';
import { buildReportHtml, CSS_RULE_BUDGET, type ReportSpec } from './reportHtml';

export interface CreateReportOptions {
    spec: ReportSpec;
    libraryID: number;
    /** Attach under a regular item. Mutually exclusive with `collectionID`. */
    parentItemID?: number | null;
    /** File the report as a top-level item in this collection. */
    collectionID?: number | null;
    /** Attachment title. Defaults to the report title. */
    title?: string;
    /** Tags applied after creation, e.g. for filtering generated reports. */
    tags?: string[];
}

export interface CreatedReport {
    itemID: number;
    key: string;
    libraryID: number;
    title: string;
    filename: string | null;
    byteLength: number;
    cssRuleCount: number;
    /** Reveals the report in the library pane. */
    selectUri: string | null;
    /** Opens the report in the reader. */
    openUri: string | null;
}

export class ReportCreationError extends Error {
    readonly code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = 'ReportCreationError';
        this.code = code;
    }
}

/** Builds the `zotero://open` URI for a file attachment. */
function getZoteroOpenURI(libraryID: number, key: string): string | null {
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return null;
    // @ts-ignore groupID is defined for group libraries
    const segment = library.libraryType === 'group' ? `groups/${library.groupID}` : 'library';
    return `zotero://open/${segment}/items/${key}`;
}

/**
 * The URL field is required by the import API and is surfaced in the item pane as
 * the "archived from" link. A generated report has no web origin, so a Beaver-owned
 * scheme is used rather than a plausible-looking http URL that would misrepresent
 * the item as a capture of a real page.
 *
 * Zotero derives the stored filename from the URL's last path segment, so the title
 * is slugified into it to keep the file readable on disk and in the item pane.
 */
function buildReportUrl(title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
    return `beaver://report/${slug || 'report'}`;
}

export async function createReportSnapshot(options: CreateReportOptions): Promise<CreatedReport> {
    const { spec, libraryID, parentItemID, collectionID, tags } = options;

    if (parentItemID && collectionID) {
        throw new ReportCreationError(
            'Provide either a parent item or a collection, not both.',
            'invalid_target'
        );
    }

    // Writes are gated on library exclusion before anything is created.
    const excluded = checkLibraryExcluded(libraryID);
    if (excluded) {
        throw new ReportCreationError(excluded.message, 'library_excluded');
    }
    if (!Zotero.Libraries.get(libraryID)) {
        throw new ReportCreationError(`Library ${libraryID} not found.`, 'library_not_found');
    }

    const { html, cssRuleCount } = buildReportHtml(spec);
    if (cssRuleCount > CSS_RULE_BUDGET) {
        // Above the reader's threshold the snapshot loses its palette in dark mode.
        logger(
            `createReportSnapshot: stylesheet has ${cssRuleCount} top-level rules, over the ${CSS_RULE_BUDGET} budget`,
            2
        );
    }

    const title = options.title || spec.title;

    // Re-check immediately before the write: exclusion may have changed while the
    // report was being assembled.
    const excludedNow = checkLibraryExcluded(libraryID);
    if (excludedNow) {
        throw new ReportCreationError(excludedNow.message, 'library_excluded');
    }

    const importOptions: Record<string, unknown> = {
        url: buildReportUrl(title),
        snapshotContent: html,
        title,
    };
    if (parentItemID) {
        importOptions.parentItemID = parentItemID;
    } else if (collectionID) {
        importOptions.collections = [collectionID];
    }

    const attachment = await Zotero.Attachments.importFromSnapshotContent(importOptions);

    if (tags?.length) {
        for (const tag of tags) {
            attachment.addTag(tag);
        }
        await attachment.saveTx();
    }

    return {
        itemID: attachment.id,
        key: attachment.key,
        libraryID: attachment.libraryID,
        title,
        filename: attachment.attachmentFilename || null,
        byteLength: new TextEncoder().encode(html).length,
        cssRuleCount,
        selectUri: getZoteroSelectURI(attachment.libraryID, attachment.key),
        openUri: getZoteroOpenURI(attachment.libraryID, attachment.key),
    };
}
