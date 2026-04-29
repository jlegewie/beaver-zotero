/**
 * Library-suggestions payload assembly helpers.
 */
import { serializeItemSummary } from "./zoteroSerializers";
import { logger } from "./logger";
import {
    ActiveItem,
    ActiveItemKind,
    CollectionSignal,
    RecentItem,
    SignalItem,
} from "../../react/types/librarySuggestions";

const ABSTRACT_MAX_CHARS = 500;
const ACTIVE_LOOKBACK_DAYS = 30;
const ACTIVE_ITEMS_CAP = 15;
const TOP_COLLECTIONS_CAP = 10;
const COLLECTION_SAMPLE_CAP = 10;
const RECENT_ITEMS_CAP = 10;

const REGULAR_ITEM_TYPE_EXCLUSION = `(
    SELECT itemTypeID FROM itemTypesCombined
    WHERE typeName IN ('attachment', 'note', 'annotation')
)`;


// ---------------------------------------------------------------------------
// SignalItem
// ---------------------------------------------------------------------------

/** Project a Zotero item to the compact SignalItem shape (truncated abstract, primary creator surnames). */
export async function toSignalItem(item: Zotero.Item): Promise<SignalItem> {
    const summary = await serializeItemSummary(item);

    const lastNames = (summary.creators ?? [])
        .filter((c) => c.is_primary && c.last_name)
        .map((c) => c.last_name as string);

    const abstract = summary.abstract
        ? truncate(summary.abstract, ABSTRACT_MAX_CHARS)
        : null;

    return {
        library_id: summary.library_id,
        zotero_key: summary.zotero_key,
        item_type: summary.item_type,
        title: summary.title ?? null,
        creators: lastNames.length > 0 ? lastNames : null,
        year: summary.year ?? null,
        abstract,
    };
}


// ---------------------------------------------------------------------------
// Active items (annotated / read / noted in trailing window)
// ---------------------------------------------------------------------------

interface CandidateRow {
    parentItemID: number;         // resolved top-level (regular) item
    kind: ActiveItemKind;
    timestampMs: number;
}

/** Return regular items annotated, noted, or read within the lookback window, ranked by most recent activity. */
export async function getActiveItems(
    libraryID: number,
    lookbackDays: number = ACTIVE_LOOKBACK_DAYS,
    cap: number = ACTIVE_ITEMS_CAP,
): Promise<ActiveItem[]> {
    const cutoffMs = Date.now() - lookbackDays * 86400000;
    const cutoffSqlUtc = msToSqlUtc(cutoffMs);
    const cutoffUnixSec = Math.floor(cutoffMs / 1000);

    const [annotationRows, noteRows, readRows] = await Promise.all([
        queryAnnotationActivity(libraryID, cutoffSqlUtc),
        queryNoteActivity(libraryID, cutoffSqlUtc),
        queryReadActivity(libraryID, cutoffUnixSec),
    ]);

    const candidates: CandidateRow[] = [
        ...annotationRows,
        ...noteRows,
        ...readRows,
    ];
    if (candidates.length === 0) return [];

    const aggregated = new Map<
        number,
        { itemID: number; kinds: Set<ActiveItemKind>; lastMs: number }
    >();
    for (const c of candidates) {
        const existing = aggregated.get(c.parentItemID);
        if (existing) {
            existing.kinds.add(c.kind);
            if (c.timestampMs > existing.lastMs) existing.lastMs = c.timestampMs;
        } else {
            aggregated.set(c.parentItemID, {
                itemID: c.parentItemID,
                kinds: new Set([c.kind]),
                lastMs: c.timestampMs,
            });
        }
    }

    const ranked = Array.from(aggregated.values())
        .sort((a, b) => b.lastMs - a.lastMs)
        .slice(0, cap);

    const parents = await Zotero.Items.getAsync(ranked.map((r) => r.itemID));
    await Zotero.Items.loadDataTypes(parents, ["itemData", "creators", "tags", "collections"]);
    const parentById = new Map(parents.map((p) => [p.id, p]));

    const out: ActiveItem[] = [];
    for (const entry of ranked) {
        const parent = parentById.get(entry.itemID);
        if (!parent || !parent.isRegularItem()) continue;
        const base = await toSignalItem(parent);
        out.push({
            ...base,
            kinds: Array.from(entry.kinds),
            last_engaged_at: new Date(entry.lastMs).toISOString(),
        });
    }
    return out;
}

async function queryAnnotationActivity(
    libraryID: number,
    cutoffSqlUtc: string,
): Promise<CandidateRow[]> {
    const sql = `
        SELECT ia.parentItemID, i.dateModified
        FROM items i
        JOIN itemAnnotations ann ON ann.itemID = i.itemID
        JOIN itemAttachments ia ON ia.itemID = ann.parentItemID
        WHERE i.libraryID = ?
          AND i.dateModified > ?
          AND ia.parentItemID IS NOT NULL
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    const rows: CandidateRow[] = [];
    await Zotero.DB.queryAsync(sql, [libraryID, cutoffSqlUtc], {
        onRow: (row: any) => {
            rows.push({
                parentItemID: row.getResultByIndex(0),
                kind: "annotated",
                timestampMs: sqlUtcToMs(row.getResultByIndex(1)),
            });
        },
    });
    return rows;
}

async function queryNoteActivity(
    libraryID: number,
    cutoffSqlUtc: string,
): Promise<CandidateRow[]> {
    const sql = `
        SELECT COALESCE(ia.parentItemID, n.parentItemID) AS topID, i.dateModified
        FROM items i
        JOIN itemNotes n ON n.itemID = i.itemID
        LEFT JOIN itemAttachments ia ON ia.itemID = n.parentItemID
        WHERE i.libraryID = ?
          AND i.dateModified > ?
          AND n.parentItemID IS NOT NULL
          AND COALESCE(ia.parentItemID, n.parentItemID) IS NOT NULL
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    const rows: CandidateRow[] = [];
    await Zotero.DB.queryAsync(sql, [libraryID, cutoffSqlUtc], {
        onRow: (row: any) => {
            rows.push({
                parentItemID: row.getResultByIndex(0),
                kind: "noted",
                timestampMs: sqlUtcToMs(row.getResultByIndex(1)),
            });
        },
    });
    return rows;
}

/** Reads resolve to the attachment's parent regular item; standalone attachments skipped. */
async function queryReadActivity(
    libraryID: number,
    cutoffUnixSec: number,
): Promise<CandidateRow[]> {
    const sql = `
        SELECT ia.parentItemID, ia.lastRead
        FROM items i
        JOIN itemAttachments ia ON ia.itemID = i.itemID
        WHERE i.libraryID = ?
          AND ia.lastRead IS NOT NULL
          AND ia.lastRead > ?
          AND ia.parentItemID IS NOT NULL
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    const rows: CandidateRow[] = [];
    await Zotero.DB.queryAsync(sql, [libraryID, cutoffUnixSec], {
        onRow: (row: any) => {
            rows.push({
                parentItemID: row.getResultByIndex(0),
                kind: "read",
                timestampMs: (row.getResultByIndex(1) as number) * 1000,
            });
        },
    });
    return rows;
}


// ---------------------------------------------------------------------------
// Top collections (with sample_items + item_refs) and lightweight all-list
// ---------------------------------------------------------------------------

interface CollectionRow {
    collectionID: number;
    key: string;
    name: string;
    parentKey: string | null;
    itemCount: number;
}

/** Return the largest collections (by item count) with item refs and a sampled subset of items; always includes the current collection if set. */
export async function getTopCollections(
    libraryID: number,
    currentCollectionKey: string | null,
    cap: number = TOP_COLLECTIONS_CAP,
): Promise<CollectionSignal[]> {
    const all = await queryCollectionsWithCounts(libraryID);
    if (all.length === 0) return [];

    const ranked = [...all].sort((a, b) => b.itemCount - a.itemCount);
    const picked: CollectionRow[] = ranked.slice(0, cap);
    const pickedKeys = new Set(picked.map((c) => c.key));

    if (currentCollectionKey && !pickedKeys.has(currentCollectionKey)) {
        const current = all.find((c) => c.key === currentCollectionKey);
        if (current) picked.push(current);
    }

    const out: CollectionSignal[] = [];
    for (const row of picked) {
        const itemRefs = await getRegularItemKeysInCollection(row.collectionID);
        const sampleIDs = pickEvenly(itemRefs.itemIDs, COLLECTION_SAMPLE_CAP);
        const sampleItems = await hydrateSignalItems(sampleIDs);
        out.push({
            library_id: libraryID,
            zotero_key: row.key,
            name: row.name,
            parent_key: row.parentKey,
            item_count: row.itemCount,
            date_added: null,                 // collections have no dateAdded in Zotero
            is_current_view: row.key === currentCollectionKey,
            item_refs: itemRefs.keys.map((zotero_key) => ({ library_id: libraryID, zotero_key })),
            sample_items: sampleItems,
        });
    }
    return out;
}

/** Return all collections in the library as lightweight signals (no item refs or sample items). */
export async function getAllCollections(libraryID: number): Promise<CollectionSignal[]> {
    const all = await queryCollectionsWithCounts(libraryID);
    return all.map((row) => ({
        library_id: libraryID,
        zotero_key: row.key,
        name: row.name,
        parent_key: row.parentKey,
        item_count: row.itemCount,
        date_added: null,
        is_current_view: false,
    }));
}

async function queryCollectionsWithCounts(libraryID: number): Promise<CollectionRow[]> {
    const sql = `
        SELECT c.collectionID, c.key, c.collectionName, parent.key AS parentKey,
               (
                   SELECT COUNT(*)
                   FROM collectionItems ci
                   JOIN items i ON i.itemID = ci.itemID
                   WHERE ci.collectionID = c.collectionID
                     AND i.itemTypeID NOT IN ${REGULAR_ITEM_TYPE_EXCLUSION}
                     AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
               ) AS itemCount
        FROM collections c
        LEFT JOIN collections parent ON parent.collectionID = c.parentCollectionID
        WHERE c.libraryID = ?
          AND c.collectionID NOT IN (SELECT collectionID FROM deletedCollections)
    `;
    const rows: CollectionRow[] = [];
    await Zotero.DB.queryAsync(sql, [libraryID], {
        onRow: (row: any) => {
            rows.push({
                collectionID: row.getResultByIndex(0),
                key: row.getResultByIndex(1),
                name: row.getResultByIndex(2),
                parentKey: row.getResultByIndex(3) ?? null,
                itemCount: row.getResultByIndex(4) ?? 0,
            });
        },
    });
    return rows;
}

async function getRegularItemKeysInCollection(
    collectionID: number,
): Promise<{ itemIDs: number[]; keys: string[] }> {
    const sql = `
        SELECT i.itemID, i.key
        FROM collectionItems ci
        JOIN items i ON i.itemID = ci.itemID
        WHERE ci.collectionID = ?
          AND i.itemTypeID NOT IN ${REGULAR_ITEM_TYPE_EXCLUSION}
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        ORDER BY ci.orderIndex
    `;
    const itemIDs: number[] = [];
    const keys: string[] = [];
    await Zotero.DB.queryAsync(sql, [collectionID], {
        onRow: (row: any) => {
            itemIDs.push(row.getResultByIndex(0));
            keys.push(row.getResultByIndex(1));
        },
    });
    return { itemIDs, keys };
}


// ---------------------------------------------------------------------------
// Recent items (most recently added regular items)
// ---------------------------------------------------------------------------

/** Return the most recently added regular items in the library, ordered by dateAdded descending. */
export async function getRecentItems(
    libraryID: number,
    cap: number = RECENT_ITEMS_CAP,
): Promise<RecentItem[]> {
    const sql = `
        SELECT itemID, dateAdded
        FROM items
        WHERE libraryID = ?
          AND itemTypeID NOT IN ${REGULAR_ITEM_TYPE_EXCLUSION}
          AND itemID NOT IN (SELECT itemID FROM deletedItems)
        ORDER BY dateAdded DESC
        LIMIT ?
    `;
    const rows: { itemID: number; dateAddedSqlUtc: string }[] = [];
    await Zotero.DB.queryAsync(sql, [libraryID, cap], {
        onRow: (row: any) => {
            rows.push({
                itemID: row.getResultByIndex(0),
                dateAddedSqlUtc: row.getResultByIndex(1),
            });
        },
    });
    if (rows.length === 0) return [];

    const items = await Zotero.Items.getAsync(rows.map((r) => r.itemID));
    await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "tags", "collections"]);
    const byId = new Map(items.map((i) => [i.id, i]));

    const out: RecentItem[] = [];
    for (const row of rows) {
        const item = byId.get(row.itemID);
        if (!item) continue;
        const base = await toSignalItem(item);
        out.push({
            ...base,
            date_added: Zotero.Date.sqlToISO8601(row.dateAddedSqlUtc),
        });
    }
    return out;
}


// ---------------------------------------------------------------------------
// Library shape (counts)
// ---------------------------------------------------------------------------

/** Return aggregate counts describing the library: regular item count, tag count, and unfiled item count. */
export async function getLibraryShape(libraryID: number): Promise<{
    library_size: number;
    total_tag_count: number;
    unfiled_item_count: number;
}> {
    const librarySizeSQL = `
        SELECT COUNT(*) FROM items
        WHERE libraryID = ?
          AND itemTypeID NOT IN ${REGULAR_ITEM_TYPE_EXCLUSION}
          AND itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    const unfiledSQL = `
        SELECT COUNT(*) FROM items
        WHERE libraryID = ?
          AND itemTypeID NOT IN ${REGULAR_ITEM_TYPE_EXCLUSION}
          AND itemID NOT IN (SELECT itemID FROM deletedItems)
          AND itemID NOT IN (SELECT itemID FROM collectionItems)
    `;

    const [librarySize, unfiledCount, tags] = await Promise.all([
        Zotero.DB.valueQueryAsync(librarySizeSQL, [libraryID]),
        Zotero.DB.valueQueryAsync(unfiledSQL, [libraryID]),
        Promise.resolve(Zotero.Tags.getAll(libraryID)),
    ]);

    return {
        library_size: Number(librarySize) || 0,
        total_tag_count: Array.isArray(tags) ? tags.length : 0,
        unfiled_item_count: Number(unfiledCount) || 0,
    };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hydrateSignalItems(itemIDs: number[]): Promise<SignalItem[]> {
    if (itemIDs.length === 0) return [];
    const items = await Zotero.Items.getAsync(itemIDs);
    await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "tags", "collections"]);
    const out: SignalItem[] = [];
    for (const item of items) {
        try {
            out.push(await toSignalItem(item));
        } catch (e) {
            logger(`librarySignals: failed to serialize item ${item.id}: ${e}`, 1);
        }
    }
    return out;
}

function pickEvenly<T>(arr: T[], cap: number): T[] {
    if (arr.length <= cap) return arr.slice();
    const out: T[] = [];
    const step = (arr.length - 1) / (cap - 1);
    for (let i = 0; i < cap; i++) {
        out.push(arr[Math.round(i * step)]);
    }
    return out;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max).trimEnd();
}

/** Format a JS millisecond epoch as the SQL UTC string Zotero stores. */
function msToSqlUtc(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
         + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Parse Zotero's SQL UTC timestamp ('YYYY-MM-DD HH:MM:SS') to ms epoch. */
function sqlUtcToMs(sqlUtc: string): number {
    // Treat as UTC; replace space with T and append Z so Date parses correctly.
    return Date.parse(sqlUtc.replace(" ", "T") + "Z");
}
