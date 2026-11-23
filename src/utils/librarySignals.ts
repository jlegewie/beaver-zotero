/**
 * Local library signals: recently active and recently added items.
 */
import { serializeItemSummary } from "./zoteroSerializers";
import { hasAgentSupportedAttachment } from "./agentItemSupport";
import {
    ActiveItem,
    ActiveItemKind,
    RecentItem,
    SignalItem,
} from "@beaver/agent-core/types/librarySuggestions";

const ABSTRACT_MAX_CHARS = 500;
const ACTIVE_LOOKBACK_DAYS = 30;
const ACTIVE_ITEMS_CAP = 15;
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

    const supported = await hasAgentSupportedAttachment(item);

    return {
        library_id: summary.library_id,
        zotero_key: summary.zotero_key,
        library_ref: summary.library_ref,
        item_type: summary.item_type,
        title: summary.title ?? null,
        creators: lastNames.length > 0 ? lastNames : null,
        year: summary.year ?? null,
        abstract,
        has_supported_attachment: supported,
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
    await Zotero.Items.loadDataTypes(parents, ["itemData", "creators", "tags", "collections", "childItems"]);
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
    await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "tags", "collections", "childItems"]);
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
// Helpers
// ---------------------------------------------------------------------------

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
