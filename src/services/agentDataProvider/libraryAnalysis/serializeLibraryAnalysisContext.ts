import { logger } from '../../../utils/logger';
import { getSearchableLibraryIds, formatCreatorsString, extractYear } from '../utils';
import type {
    LibraryAnalysisContext,
    LibraryAnalysisOptions,
    LibrarySummary,
    CollectionNode,
    TagSummary,
    RecentActivity,
    RecentItem,
    RecentAnnotationSummary,
    RecentNote,
    OpenTab,
    MetadataQualityReport,
} from './types';

// Item types to exclude from "regular items" counts
const ANNOTATION_TYPE_ID = 1;   // Zotero.ItemTypes.getID('annotation')
const ATTACHMENT_TYPE_ID = 3;   // Zotero.ItemTypes.getID('attachment')
const NOTE_TYPE_ID = 28;        // Zotero.ItemTypes.getID('note')

// Field IDs for metadata quality checks
const FIELD_ID_TITLE = 1;
const FIELD_ID_ABSTRACT = 2;
const FIELD_ID_DATE = 6;
const FIELD_ID_DOI = 59;

// Item types where DOI is meaningfully expected
const DOI_ITEM_TYPES = new Set([
    'journalArticle', 'conferencePaper', 'preprint', 'bookSection',
    'book', 'dataset', 'thesis', 'report', 'standard',
]);

const DEFAULT_OPTIONS: Required<LibraryAnalysisOptions> = {
    lookbackDays: 30,
    includeReadOnly: false,
    includeNotes: false,
    maxCollectionsPerLibrary: 200,
    maxTagsPerLibrary: 30,
    maxRecentItems: 30,
    maxRecentAnnotations: 15,
    maxRecentNotes: 10,
    maxWorstItems: 10,
};

export async function serializeLibraryAnalysisContext(
    options?: LibraryAnalysisOptions
): Promise<LibraryAnalysisContext> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    const searchableLibraryIds = getSearchableLibraryIds();
    const allLibraries = Zotero.Libraries.getAll()
        .filter((lib: any) => searchableLibraryIds.includes(lib.libraryID));

    const targetLibraries = opts.includeReadOnly
        ? allLibraries
        : allLibraries.filter((lib: any) => lib.editable);

    // Gather data in parallel
    const [librarySummaries, recentActivity, openTabs, metadataQuality] = await Promise.all([
        Promise.all(targetLibraries.map((lib: any) => buildLibrarySummary(lib, opts))),
        buildRecentActivity(targetLibraries, opts),
        buildOpenTabs(),
        buildMetadataQualityReport(targetLibraries, opts),
    ]);

    return {
        generated_at: new Date().toISOString(),
        libraries: librarySummaries,
        recent_activity: recentActivity,
        open_tabs: openTabs,
        metadata_quality: metadataQuality,
    };
}

// ---------------------------------------------------------------------------
// Library Summary
// ---------------------------------------------------------------------------

async function buildLibrarySummary(
    library: any,
    opts: Required<LibraryAnalysisOptions>,
): Promise<LibrarySummary> {
    const libraryID = library.libraryID;

    const [
        itemCount,
        collectionCount,
        tagCount,
        unfiledItemCount,
        { hasPublications, publicationsCount },
        collections,
        topTags,
    ] = await Promise.all([
        countRegularItems(libraryID),
        countCollections(libraryID),
        countTags(libraryID),
        countUnfiledItems(libraryID),
        countPublications(libraryID),
        getCollections(libraryID, opts.maxCollectionsPerLibrary),
        getTopTags(libraryID, opts.maxTagsPerLibrary),
    ]);

    return {
        library_id: libraryID,
        name: library.name,
        is_group: library.isGroup,
        read_only: !library.editable || !library.filesEditable,

        item_count: itemCount,
        collection_count: collectionCount,
        tag_count: tagCount,

        unfiled_item_count: unfiledItemCount,
        has_publications: hasPublications,
        publications_count: publicationsCount,

        collections: collections.nodes,
        collection_tree_truncated: collections.truncated,

        top_tags: topTags,
    };
}

async function countRegularItems(libraryID: number): Promise<number> {
    let count = 0;
    try {
        const sql = `
            SELECT COUNT(*) FROM items i
            LEFT JOIN itemNotes USING (itemID)
            LEFT JOIN itemAttachments USING (itemID)
            LEFT JOIN itemAnnotations USING (itemID)
            WHERE i.libraryID = ?
            AND itemNotes.itemID IS NULL
            AND itemAttachments.itemID IS NULL
            AND itemAnnotations.itemID IS NULL
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        await Zotero.DB.queryAsync(sql, [libraryID], {
            onRow: (row: any) => { count = row.getResultByIndex(0) as number; }
        });
    } catch (e) {
        logger(`libraryAnalysis: countRegularItems error for lib ${libraryID}: ${e}`, 1);
    }
    return count;
}

async function countCollections(libraryID: number): Promise<number> {
    let count = 0;
    try {
        const sql = `
            SELECT COUNT(*) FROM collections
            WHERE libraryID = ?
            AND collectionID NOT IN (SELECT collectionID FROM deletedCollections)
        `;
        await Zotero.DB.queryAsync(sql, [libraryID], {
            onRow: (row: any) => { count = row.getResultByIndex(0) as number; }
        });
    } catch (e) {
        logger(`libraryAnalysis: countCollections error for lib ${libraryID}: ${e}`, 1);
    }
    return count;
}

async function countTags(libraryID: number): Promise<number> {
    try {
        const tags = await Zotero.Tags.getAll(libraryID);
        return (tags as any[]).length;
    } catch (e) {
        logger(`libraryAnalysis: countTags error for lib ${libraryID}: ${e}`, 1);
        return 0;
    }
}

async function countUnfiledItems(libraryID: number): Promise<number> {
    let count = 0;
    try {
        const sql = `
            SELECT COUNT(*) FROM items i
            LEFT JOIN itemNotes USING (itemID)
            LEFT JOIN itemAttachments USING (itemID)
            LEFT JOIN itemAnnotations USING (itemID)
            LEFT JOIN collectionItems ci ON i.itemID = ci.itemID
            WHERE i.libraryID = ?
            AND itemNotes.itemID IS NULL
            AND itemAttachments.itemID IS NULL
            AND itemAnnotations.itemID IS NULL
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND ci.itemID IS NULL
        `;
        await Zotero.DB.queryAsync(sql, [libraryID], {
            onRow: (row: any) => { count = row.getResultByIndex(0) as number; }
        });
    } catch (e) {
        logger(`libraryAnalysis: countUnfiledItems error for lib ${libraryID}: ${e}`, 1);
    }
    return count;
}

async function countPublications(libraryID: number): Promise<{ hasPublications: boolean; publicationsCount: number }> {
    // publicationsItems only applies to the user's personal library
    if (libraryID !== Zotero.Libraries.userLibraryID) {
        return { hasPublications: false, publicationsCount: 0 };
    }
    let count = 0;
    try {
        const sql = `
            SELECT COUNT(*) FROM publicationsItems pi
            JOIN items i ON pi.itemID = i.itemID
            WHERE i.libraryID = ?
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        await Zotero.DB.queryAsync(sql, [libraryID], {
            onRow: (row: any) => { count = row.getResultByIndex(0) as number; }
        });
    } catch (e) {
        logger(`libraryAnalysis: countPublications error for lib ${libraryID}: ${e}`, 1);
    }
    return { hasPublications: count > 0, publicationsCount: count };
}

async function getCollections(
    libraryID: number,
    maxCollections: number,
): Promise<{ nodes: CollectionNode[]; truncated: boolean }> {
    const nodes: CollectionNode[] = [];
    try {
        const sql = `
            SELECT c.key, c.collectionName, cp.key as parentKey,
                   COUNT(ci.itemID) as itemCount
            FROM collections c
            LEFT JOIN collections cp ON c.parentCollectionID = cp.collectionID
            LEFT JOIN collectionItems ci ON c.collectionID = ci.collectionID
                AND ci.itemID IN (
                    SELECT i.itemID FROM items i
                    LEFT JOIN itemNotes USING (itemID)
                    LEFT JOIN itemAttachments USING (itemID)
                    LEFT JOIN itemAnnotations USING (itemID)
                    WHERE itemNotes.itemID IS NULL
                    AND itemAttachments.itemID IS NULL
                    AND itemAnnotations.itemID IS NULL
                    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
                )
            WHERE c.libraryID = ?
            AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)
            GROUP BY c.collectionID
            ORDER BY c.collectionName
        `;
        await Zotero.DB.queryAsync(sql, [libraryID], {
            onRow: (row: any) => {
                nodes.push({
                    collection_key: row.getResultByIndex(0) as string,
                    name: row.getResultByIndex(1) as string,
                    parent_collection_key: row.getResultByIndex(2) as string | null,
                    item_count: row.getResultByIndex(3) as number,
                });
            }
        });
    } catch (e) {
        logger(`libraryAnalysis: getCollections error for lib ${libraryID}: ${e}`, 1);
    }

    const truncated = nodes.length > maxCollections;
    return {
        nodes: truncated ? nodes.slice(0, maxCollections) : nodes,
        truncated,
    };
}

async function getTopTags(
    libraryID: number,
    maxTags: number,
): Promise<TagSummary[]> {
    // Get tag item counts via SQL (only regular items)
    const tagCounts: { name: string; count: number }[] = [];
    try {
        const sql = `
            SELECT t.name, COUNT(DISTINCT it.itemID) as cnt
            FROM tags t
            JOIN itemTags it USING (tagID)
            JOIN items i ON it.itemID = i.itemID
            LEFT JOIN itemNotes USING (itemID)
            LEFT JOIN itemAttachments USING (itemID)
            LEFT JOIN itemAnnotations USING (itemID)
            WHERE i.libraryID = ?
            AND itemNotes.itemID IS NULL
            AND itemAttachments.itemID IS NULL
            AND itemAnnotations.itemID IS NULL
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            GROUP BY t.tagID
            ORDER BY cnt DESC
            LIMIT ?
        `;
        await Zotero.DB.queryAsync(sql, [libraryID, maxTags], {
            onRow: (row: any) => {
                tagCounts.push({
                    name: row.getResultByIndex(0) as string,
                    count: row.getResultByIndex(1) as number,
                });
            }
        });
    } catch (e) {
        logger(`libraryAnalysis: getTopTags error for lib ${libraryID}: ${e}`, 1);
        return [];
    }

    // Get tag colors
    let colorMap: any;
    try {
        colorMap = Zotero.Tags.getColors(libraryID);
    } catch (e) {
        colorMap = null;
    }

    return tagCounts.map(tc => ({
        name: tc.name,
        item_count: tc.count,
        color: colorMap && colorMap.has(tc.name) ? colorMap.get(tc.name).color : null,
    }));
}

// ---------------------------------------------------------------------------
// Recent Activity
// ---------------------------------------------------------------------------

async function buildRecentActivity(
    libraries: any[],
    opts: Required<LibraryAnalysisOptions>,
): Promise<RecentActivity> {
    const libraryIDs = libraries.map((lib: any) => lib.libraryID);
    if (libraryIDs.length === 0) {
        return { recently_added_items: [], recently_annotated_items: [], recent_notes: [], lookback_days: opts.lookbackDays };
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - opts.lookbackDays);
    const cutoffISO = cutoffDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    const libPlaceholders = libraryIDs.map(() => '?').join(',');

    const [recentItems, recentAnnotations, recentNotes] = await Promise.all([
        getRecentlyAddedItems(libraryIDs, libPlaceholders, cutoffISO, opts.maxRecentItems),
        getRecentlyAnnotatedItems(libraryIDs, libPlaceholders, cutoffISO, opts.maxRecentAnnotations),
        opts.includeNotes
            ? getRecentNotes(libraryIDs, libPlaceholders, cutoffISO, opts.maxRecentNotes)
            : Promise.resolve([]),
    ]);

    return {
        recently_added_items: recentItems,
        recently_annotated_items: recentAnnotations,
        recent_notes: recentNotes,
        lookback_days: opts.lookbackDays,
    };
}

async function getRecentlyAddedItems(
    libraryIDs: number[],
    libPlaceholders: string,
    cutoffISO: string,
    maxItems: number,
): Promise<RecentItem[]> {
    // Fetch item IDs via SQL, then load via Zotero API for field access
    const itemRows: { itemID: number }[] = [];
    try {
        const sql = `
            SELECT i.itemID
            FROM items i
            LEFT JOIN itemNotes USING (itemID)
            LEFT JOIN itemAttachments USING (itemID)
            LEFT JOIN itemAnnotations USING (itemID)
            WHERE i.libraryID IN (${libPlaceholders})
            AND itemNotes.itemID IS NULL
            AND itemAttachments.itemID IS NULL
            AND itemAnnotations.itemID IS NULL
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND i.dateAdded >= ?
            ORDER BY i.dateAdded DESC
            LIMIT ?
        `;
        await Zotero.DB.queryAsync(sql, [...libraryIDs, cutoffISO, maxItems], {
            onRow: (row: any) => {
                itemRows.push({ itemID: row.getResultByIndex(0) as number });
            }
        });
    } catch (e) {
        logger(`libraryAnalysis: getRecentlyAddedItems SQL error: ${e}`, 1);
        return [];
    }

    if (itemRows.length === 0) return [];

    // Load items via Zotero API
    const itemIDs = itemRows.map(r => r.itemID);
    const items = await Zotero.Items.getAsync(itemIDs);
    await Zotero.Items.loadDataTypes(items, ['itemData', 'creators', 'tags', 'collections', 'childItems']);

    return items.map((item: Zotero.Item) => serializeRecentItem(item));
}

function serializeRecentItem(item: Zotero.Item): RecentItem {
    const creators = item.getCreators();
    const date = item.getField('date') as string;
    const title = item.getField('title') as string;
    const abstractNote = item.getField('abstractNote') as string;
    const itemTypeName = Zotero.ItemTypes.getName(item.itemTypeID);

    // Collection names
    const collectionIDs = item.getCollections();
    const collectionNames: string[] = [];
    for (const colID of collectionIDs) {
        const col = Zotero.Collections.get(colID);
        if (col) collectionNames.push(col.name);
    }

    // Tag names
    const tags = item.getTags();
    const tagNames = tags.map((t: any) => t.tag);

    const result: RecentItem = {
        library_id: item.libraryID,
        zotero_key: item.key,
        item_type: itemTypeName,
        title: title || '',
        creators_summary: formatCreatorsString(creators),
        date: date || null,
        year: extractYear(date),
        date_added: item.dateAdded,

        has_abstract: !!abstractNote,
        has_date: !!date,
        has_creators: creators.length > 0,
        has_attachment: item.getAttachments().length > 0,

        collections: collectionNames,
        tags: tagNames,
    };

    // Only include has_doi for item types where DOI is expected
    if (DOI_ITEM_TYPES.has(itemTypeName)) {
        let doi: string = '';
        try {
            doi = item.getField('DOI') as string;
        } catch (_) {
            // Not all item types actually support DOI field at runtime
        }
        result.has_doi = !!doi;
    }

    return result;
}

async function getRecentlyAnnotatedItems(
    libraryIDs: number[],
    libPlaceholders: string,
    cutoffISO: string,
    maxItems: number,
): Promise<RecentAnnotationSummary[]> {
    // Group annotations by parent attachment, get counts per type
    const rows: {
        parentItemID: number;
        attachmentLibraryID: number;
        attachmentKey: string;
        highlightCount: number;
        noteCount: number;
        totalCount: number;
        lastDate: string;
    }[] = [];

    try {
        // Annotation type constants: highlight=1, note=2
        const sql = `
            SELECT
                ann.parentItemID,
                i_att.libraryID,
                i_att.key,
                SUM(CASE WHEN ann.type = 1 THEN 1 ELSE 0 END) as highlightCount,
                SUM(CASE WHEN ann.type = 2 THEN 1 ELSE 0 END) as noteCount,
                COUNT(*) as totalCount,
                MAX(i_ann.dateModified) as lastDate
            FROM itemAnnotations ann
            JOIN items i_ann ON ann.itemID = i_ann.itemID
            JOIN items i_att ON ann.parentItemID = i_att.itemID
            WHERE i_att.libraryID IN (${libPlaceholders})
            AND i_ann.dateModified >= ?
            AND i_ann.itemID NOT IN (SELECT itemID FROM deletedItems)
            GROUP BY ann.parentItemID
            ORDER BY lastDate DESC
            LIMIT ?
        `;
        await Zotero.DB.queryAsync(sql, [...libraryIDs, cutoffISO, maxItems], {
            onRow: (row: any) => {
                rows.push({
                    parentItemID: row.getResultByIndex(0) as number,
                    attachmentLibraryID: row.getResultByIndex(1) as number,
                    attachmentKey: row.getResultByIndex(2) as string,
                    highlightCount: row.getResultByIndex(3) as number,
                    noteCount: row.getResultByIndex(4) as number,
                    totalCount: row.getResultByIndex(5) as number,
                    lastDate: row.getResultByIndex(6) as string,
                });
            }
        });
    } catch (e) {
        logger(`libraryAnalysis: getRecentlyAnnotatedItems SQL error: ${e}`, 1);
        return [];
    }

    if (rows.length === 0) return [];

    // Load attachment items to get parent info
    const attachmentIDs = rows.map(r => r.parentItemID);
    const attachments = await Zotero.Items.getAsync(attachmentIDs);
    await Zotero.Items.loadDataTypes(attachments, ['itemData']);

    // Build a map for quick lookup
    const attachmentMap = new Map<number, Zotero.Item>();
    for (const att of attachments) {
        attachmentMap.set(att.id, att);
    }

    // Load parent items
    const parentIDs = attachments
        .map((att: Zotero.Item) => att.parentItemID)
        .filter((id): id is number => typeof id === 'number' && id > 0);
    const parentMap = new Map<number, Zotero.Item>();
    if (parentIDs.length > 0) {
        const parentItems = await Zotero.Items.getAsync(parentIDs);
        await Zotero.Items.loadDataTypes(parentItems, ['itemData', 'creators']);
        for (const p of parentItems) {
            parentMap.set(p.id, p);
        }
    }

    return rows.map(row => {
        const att = attachmentMap.get(row.parentItemID);
        const parent = att && att.parentItemID ? parentMap.get(att.parentItemID) : null;

        return {
            attachment_library_id: row.attachmentLibraryID,
            attachment_zotero_key: row.attachmentKey,
            parent_library_id: parent ? parent.libraryID : null,
            parent_zotero_key: parent ? parent.key : null,
            parent_title: parent ? (parent.getField('title') as string) || null : null,
            parent_creators_summary: parent ? formatCreatorsString(parent.getCreators()) : null,
            highlight_count: row.highlightCount,
            note_count: row.noteCount,
            total_annotation_count: row.totalCount,
            last_annotation_date: row.lastDate,
        };
    });
}

async function getRecentNotes(
    libraryIDs: number[],
    libPlaceholders: string,
    cutoffISO: string,
    maxNotes: number,
): Promise<RecentNote[]> {
    const noteRows: { itemID: number; libraryID: number; key: string; dateModified: string; parentItemID: number | null; noteTitle: string }[] = [];
    try {
        const sql = `
            SELECT i.itemID, i.libraryID, i.key, i.dateModified,
                   n.parentItemID, n.title
            FROM items i
            JOIN itemNotes n ON i.itemID = n.itemID
            WHERE i.libraryID IN (${libPlaceholders})
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND i.dateModified >= ?
            ORDER BY i.dateModified DESC
            LIMIT ?
        `;
        await Zotero.DB.queryAsync(sql, [...libraryIDs, cutoffISO, maxNotes], {
            onRow: (row: any) => {
                noteRows.push({
                    itemID: row.getResultByIndex(0) as number,
                    libraryID: row.getResultByIndex(1) as number,
                    key: row.getResultByIndex(2) as string,
                    dateModified: row.getResultByIndex(3) as string,
                    parentItemID: row.getResultByIndex(4) as number | null,
                    noteTitle: row.getResultByIndex(5) as string || '',
                });
            }
        });
    } catch (e) {
        logger(`libraryAnalysis: getRecentNotes SQL error: ${e}`, 1);
        return [];
    }

    if (noteRows.length === 0) return [];

    // Load note items for content
    const noteIDs = noteRows.map(r => r.itemID);
    const noteItems = await Zotero.Items.getAsync(noteIDs);
    const noteItemMap = new Map<number, Zotero.Item>();
    for (const n of noteItems) {
        noteItemMap.set(n.id, n);
    }

    // Load parent items for titles
    const parentIDs = noteRows
        .map(r => r.parentItemID)
        .filter((id): id is number => id !== null && id !== 0);
    const parentMap = new Map<number, Zotero.Item>();
    if (parentIDs.length > 0) {
        const parentItems = await Zotero.Items.getAsync(parentIDs);
        await Zotero.Items.loadDataTypes(parentItems, ['itemData']);
        for (const p of parentItems) {
            parentMap.set(p.id, p);
        }
    }

    return noteRows.map(row => {
        const noteItem = noteItemMap.get(row.itemID);
        const parent = row.parentItemID ? parentMap.get(row.parentItemID) : null;

        // Get note content and strip HTML for snippet
        let snippet = '';
        if (noteItem) {
            try {
                const noteHtml = noteItem.getNote();
                snippet = stripHtml(noteHtml).slice(0, 200);
            } catch (_) {
                // getNote may fail for some items
            }
        }

        return {
            library_id: row.libraryID,
            zotero_key: row.key,
            title: row.noteTitle || snippet.slice(0, 80) || 'Untitled Note',
            parent_key: parent ? parent.key : null,
            parent_title: parent ? (parent.getField('title') as string) || null : null,
            date_modified: row.dateModified,
            snippet,
        };
    });
}

function stripHtml(html: string): string {
    if (!html) return '';
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// Open Tabs
// ---------------------------------------------------------------------------

async function buildOpenTabs(): Promise<OpenTab[]> {
    try {
        const win = Zotero.getMainWindow();
        if (!win || !win.Zotero_Tabs) return [];

        const tabs = win.Zotero_Tabs._tabs;
        const selectedID = win.Zotero_Tabs.selectedID;

        const result: OpenTab[] = [];
        for (const tab of tabs) {
            const isReader = tab.type === 'reader' || tab.type === 'reader-unloaded';
            const entry: OpenTab = {
                type: isReader ? 'reader' : 'library',
                title: tab.title || '',
                is_selected: tab.id === selectedID,
            };

            if (isReader && tab.data?.itemID) {
                try {
                    const attachment = await Zotero.Items.getAsync(tab.data.itemID);
                    if (attachment) {
                        entry.attachment_library_id = attachment.libraryID;
                        entry.attachment_zotero_key = attachment.key;

                        if (attachment.parentItemID) {
                            const parent = await Zotero.Items.getAsync(attachment.parentItemID);
                            if (parent) {
                                await Zotero.Items.loadDataTypes([parent], ['itemData', 'creators']);
                                entry.parent_library_id = parent.libraryID;
                                entry.parent_zotero_key = parent.key;
                                entry.parent_title = (parent.getField('title') as string) || undefined;
                                entry.parent_item_type = Zotero.ItemTypes.getName(parent.itemTypeID);
                                entry.parent_creators_summary = formatCreatorsString(parent.getCreators()) || undefined;
                                const date = parent.getField('date') as string;
                                const year = extractYear(date);
                                if (year) entry.parent_year = year;
                            }
                        }
                    }
                } catch (e) {
                    logger(`libraryAnalysis: buildOpenTabs error loading tab item ${tab.data.itemID}: ${e}`, 1);
                }
            }

            result.push(entry);
        }
        return result;
    } catch (e) {
        logger(`libraryAnalysis: buildOpenTabs error: ${e}`, 1);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Metadata Quality Report
// ---------------------------------------------------------------------------

async function buildMetadataQualityReport(
    libraries: any[],
    opts: Required<LibraryAnalysisOptions>,
): Promise<MetadataQualityReport> {
    const editableLibraries = libraries.filter((lib: any) => lib.editable);
    const libraryIDs = editableLibraries.map((lib: any) => lib.libraryID);

    if (libraryIDs.length === 0) {
        return {
            total_items: 0,
            missing_abstract: 0,
            missing_doi: 0,
            missing_date: 0,
            missing_creators: 0,
            missing_title: 0,
            no_attachment: 0,
            worst_items: [],
        };
    }

    const libPlaceholders = libraryIDs.map(() => '?').join(',');

    // Run all count queries in parallel
    const [totalItems, missingAbstract, missingDoi, missingDate, missingCreators, missingTitle, noAttachment, worstItems] = await Promise.all([
        countFieldQuery(libraryIDs, libPlaceholders, null, false),
        countFieldQuery(libraryIDs, libPlaceholders, FIELD_ID_ABSTRACT, true),
        countFieldQuery(libraryIDs, libPlaceholders, FIELD_ID_DOI, true),
        countFieldQuery(libraryIDs, libPlaceholders, FIELD_ID_DATE, true),
        countMissingCreators(libraryIDs, libPlaceholders),
        countFieldQuery(libraryIDs, libPlaceholders, FIELD_ID_TITLE, true),
        countMissingAttachments(libraryIDs, libPlaceholders),
        getWorstQualityItems(libraryIDs, libPlaceholders, opts.maxWorstItems),
    ]);

    return {
        total_items: totalItems,
        missing_abstract: missingAbstract,
        missing_doi: missingDoi,
        missing_date: missingDate,
        missing_creators: missingCreators,
        missing_title: missingTitle,
        no_attachment: noAttachment,
        worst_items: worstItems,
    };
}

/**
 * Count regular items, optionally those missing a specific field.
 * If fieldID is null, counts all regular items.
 * If missing is true, counts items that do NOT have the field.
 */
async function countFieldQuery(
    libraryIDs: number[],
    libPlaceholders: string,
    fieldID: number | null,
    missing: boolean,
): Promise<number> {
    let count = 0;
    try {
        let sql: string;
        let params: any[];

        if (fieldID === null) {
            // Total regular items
            sql = `
                SELECT COUNT(*) FROM items i
                LEFT JOIN itemNotes USING (itemID)
                LEFT JOIN itemAttachments USING (itemID)
                LEFT JOIN itemAnnotations USING (itemID)
                WHERE i.libraryID IN (${libPlaceholders})
                AND itemNotes.itemID IS NULL
                AND itemAttachments.itemID IS NULL
                AND itemAnnotations.itemID IS NULL
                AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            `;
            params = [...libraryIDs];
        } else if (missing) {
            // Items missing a field
            sql = `
                SELECT COUNT(*) FROM items i
                LEFT JOIN itemNotes USING (itemID)
                LEFT JOIN itemAttachments USING (itemID)
                LEFT JOIN itemAnnotations USING (itemID)
                LEFT JOIN itemData id ON i.itemID = id.itemID AND id.fieldID = ?
                WHERE i.libraryID IN (${libPlaceholders})
                AND itemNotes.itemID IS NULL
                AND itemAttachments.itemID IS NULL
                AND itemAnnotations.itemID IS NULL
                AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
                AND id.itemID IS NULL
            `;
            params = [fieldID, ...libraryIDs];
        } else {
            sql = `
                SELECT COUNT(*) FROM items i
                LEFT JOIN itemNotes USING (itemID)
                LEFT JOIN itemAttachments USING (itemID)
                LEFT JOIN itemAnnotations USING (itemID)
                JOIN itemData id ON i.itemID = id.itemID AND id.fieldID = ?
                WHERE i.libraryID IN (${libPlaceholders})
                AND itemNotes.itemID IS NULL
                AND itemAttachments.itemID IS NULL
                AND itemAnnotations.itemID IS NULL
                AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            `;
            params = [fieldID, ...libraryIDs];
        }

        await Zotero.DB.queryAsync(sql, params, {
            onRow: (row: any) => { count = row.getResultByIndex(0) as number; }
        });
    } catch (e) {
        logger(`libraryAnalysis: countFieldQuery error (fieldID=${fieldID}): ${e}`, 1);
    }
    return count;
}

async function countMissingCreators(
    libraryIDs: number[],
    libPlaceholders: string,
): Promise<number> {
    let count = 0;
    try {
        const sql = `
            SELECT COUNT(*) FROM items i
            LEFT JOIN itemNotes USING (itemID)
            LEFT JOIN itemAttachments USING (itemID)
            LEFT JOIN itemAnnotations USING (itemID)
            LEFT JOIN itemCreators ic ON i.itemID = ic.itemID
            WHERE i.libraryID IN (${libPlaceholders})
            AND itemNotes.itemID IS NULL
            AND itemAttachments.itemID IS NULL
            AND itemAnnotations.itemID IS NULL
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND ic.itemID IS NULL
        `;
        await Zotero.DB.queryAsync(sql, [...libraryIDs], {
            onRow: (row: any) => { count = row.getResultByIndex(0) as number; }
        });
    } catch (e) {
        logger(`libraryAnalysis: countMissingCreators error: ${e}`, 1);
    }
    return count;
}

async function countMissingAttachments(
    libraryIDs: number[],
    libPlaceholders: string,
): Promise<number> {
    let count = 0;
    try {
        const sql = `
            SELECT COUNT(*) FROM items i
            LEFT JOIN itemNotes USING (itemID)
            LEFT JOIN itemAttachments ia_self USING (itemID)
            LEFT JOIN itemAnnotations USING (itemID)
            LEFT JOIN itemAttachments ia_child ON i.itemID = ia_child.parentItemID
            WHERE i.libraryID IN (${libPlaceholders})
            AND itemNotes.itemID IS NULL
            AND ia_self.itemID IS NULL
            AND itemAnnotations.itemID IS NULL
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND ia_child.itemID IS NULL
        `;
        await Zotero.DB.queryAsync(sql, [...libraryIDs], {
            onRow: (row: any) => { count = row.getResultByIndex(0) as number; }
        });
    } catch (e) {
        logger(`libraryAnalysis: countMissingAttachments error: ${e}`, 1);
    }
    return count;
}

async function getWorstQualityItems(
    libraryIDs: number[],
    libPlaceholders: string,
    maxItems: number,
): Promise<RecentItem[]> {
    // Score items by number of missing key fields; higher = worse quality
    const itemIDs: number[] = [];
    try {
        const sql = `
            SELECT i.itemID,
                (CASE WHEN id_title.itemID IS NULL THEN 1 ELSE 0 END
                 + CASE WHEN id_abstract.itemID IS NULL THEN 1 ELSE 0 END
                 + CASE WHEN id_doi.itemID IS NULL THEN 1 ELSE 0 END
                 + CASE WHEN id_date.itemID IS NULL THEN 1 ELSE 0 END
                 + CASE WHEN ic.itemID IS NULL THEN 1 ELSE 0 END
                 + CASE WHEN ia_child.itemID IS NULL THEN 1 ELSE 0 END
                ) as missing_score
            FROM items i
            LEFT JOIN itemNotes USING (itemID)
            LEFT JOIN itemAttachments ia_self USING (itemID)
            LEFT JOIN itemAnnotations USING (itemID)
            LEFT JOIN itemData id_title ON i.itemID = id_title.itemID AND id_title.fieldID = ${FIELD_ID_TITLE}
            LEFT JOIN itemData id_abstract ON i.itemID = id_abstract.itemID AND id_abstract.fieldID = ${FIELD_ID_ABSTRACT}
            LEFT JOIN itemData id_doi ON i.itemID = id_doi.itemID AND id_doi.fieldID = ${FIELD_ID_DOI}
            LEFT JOIN itemData id_date ON i.itemID = id_date.itemID AND id_date.fieldID = ${FIELD_ID_DATE}
            LEFT JOIN itemCreators ic ON i.itemID = ic.itemID
            LEFT JOIN itemAttachments ia_child ON i.itemID = ia_child.parentItemID
            WHERE i.libraryID IN (${libPlaceholders})
            AND itemNotes.itemID IS NULL
            AND ia_self.itemID IS NULL
            AND itemAnnotations.itemID IS NULL
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            GROUP BY i.itemID
            HAVING missing_score >= 2
            ORDER BY missing_score DESC, i.dateModified DESC
            LIMIT ?
        `;
        await Zotero.DB.queryAsync(sql, [...libraryIDs, maxItems], {
            onRow: (row: any) => {
                itemIDs.push(row.getResultByIndex(0) as number);
            }
        });
    } catch (e) {
        logger(`libraryAnalysis: getWorstQualityItems SQL error: ${e}`, 1);
        return [];
    }

    if (itemIDs.length === 0) return [];

    const items = await Zotero.Items.getAsync(itemIDs);
    await Zotero.Items.loadDataTypes(items, ['itemData', 'creators', 'tags', 'collections', 'childItems']);

    return items.map((item: Zotero.Item) => serializeRecentItem(item));
}
