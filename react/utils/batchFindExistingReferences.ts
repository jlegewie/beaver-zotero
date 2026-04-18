/**
 * Batch Reference Finder
 *
 * Optimized batch lookup for checking if multiple external references exist in Zotero.
 *
 * Execution model:
 *   Phase 1 — Identifier match (DOI + ISBN) in a single SQL pass each.
 *   Phase 2 — Title match for items not already matched by Phase 1:
 *     2a. Exact-value title fast path: BINARY equality against
 *         itemDataValues.value. Catches most titles that match byte-for-byte
 *         between input source (OpenAlex, etc.) and the Zotero DB.
 *     2b. Keyword LIKE scan: runs for every normalized input title (not
 *         just ones 2a missed). 2a can return a wrong candidate that
 *         Phase 3 later rejects; 2b must still scan so a case/whitespace
 *         variant isn't missed. Dedup on itemID.
 *     2c. Meta fetch — DOI / ISBN / date / creators — for candidate itemIDs.
 *   Phase 3 — In-memory fuzzy match (title / DOI / ISBN / year / creator).
 *
 * Phase 1 and Phase 2 run sequentially because Zotero's SQLite connection
 * serializes queries — `Promise.all` provided no real concurrency and caused
 * misleading per-phase timings. Running Phase 2 only on unresolved items
 * also avoids scanning titles for references already matched by DOI/ISBN.
 */

import { FindReferenceData } from './findExistingReference';
import { ZoteroItemReference } from '../types/zotero';
import { logger } from '../../src/utils/logger';

/**
 * Lightweight representation of a title-matched candidate from Zotero DB.
 */
interface TitleCandidate {
    libraryID: number;
    key: string;
    normalizedTitle: string;
    doi: string | null;
    isbn: string | null;
    date: string | null;
    creatorLastNames: string[];
}

/**
 * Input item for batch reference checking
 */
export interface BatchReferenceCheckItem {
    /** Unique identifier for this item in the request */
    id: string;
    /** Reference data to check */
    data: FindReferenceData;
}

/**
 * Result of a batch reference check for a single item
 */
export interface BatchReferenceCheckResult {
    /** The id from the input */
    id: string;
    /** The found reference, or null if not found */
    item: ZoteroItemReference | null;
}

/**
 * Timing breakdown for batch reference checking
 */
export interface BatchReferenceCheckTiming {
    total_ms: number;
    phase1_identifier_lookup_ms: number;
    phase2_title_candidates_ms: number;
    phase3_fuzzy_matching_ms: number;
    candidates_fetched: number;
    matches_by_identifier: number;
    matches_by_fuzzy: number;
}

// SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 999 on older builds and
// 32766 on newer ones; 500 keeps us well within either limit while still
// letting each batch pack plenty of parameters.
const SQL_CHUNK_SIZE = 500;

function normalizeString(str: string | undefined | null): string {
    const s = str ? str + "" : "";
    if (s === "") return "";
    return Zotero.Utilities.removeDiacritics(s)
        .replace(/[ !-/:-@[-`{-~]+/g, ' ') // Convert (ASCII) punctuation to spaces
        .trim()
        .toLowerCase();
}

function parseYear(yearStr: string | undefined | null): number | null {
    if (!yearStr) return null;
    const parsed = parseInt(String(yearStr));
    return isNaN(parsed) ? null : parsed;
}

/**
 * Extract a single discriminating keyword from a title for SQL LIKE pre-filtering.
 * Prefers ASCII-only words — they match reliably across diacritics variants
 * under LOWER()+LIKE. Falls back to non-ASCII if no ASCII word is available.
 */
function extractFilterKeywords(title: string, maxKeywords: number = 1): string[] {
    const lowered = (title + "")
        .replace(/[ !-/:-@[-`{-~]+/g, ' ') // Same punctuation → space as normalizeString
        .trim()
        .toLowerCase();
    const words = lowered.split(/\s+/).filter(w => w.length >= 2);
    words.sort((a, b) => b.length - a.length);
    const ascii = words.filter(w => /^[\x20-\x7e]+$/.test(w));
    const nonAscii = words.filter(w => !/^[\x20-\x7e]+$/.test(w));
    const result = [...ascii.slice(0, maxKeywords)];
    if (result.length < maxKeywords) {
        result.push(...nonAscii.slice(0, maxKeywords - result.length));
    }
    return result;
}

function cleanIdentifiers(items: BatchReferenceCheckItem[]): {
    doiMap: Map<string, string[]>;
    isbnMap: Map<string, string[]>;
    needsFuzzyMatch: BatchReferenceCheckItem[];
} {
    const doiMap = new Map<string, string[]>();
    const isbnMap = new Map<string, string[]>();
    const needsFuzzyMatch: BatchReferenceCheckItem[] = [];

    for (const item of items) {
        if (item.data.DOI) {
            const cleanDOI = Zotero.Utilities.cleanDOI(item.data.DOI);
            if (cleanDOI) {
                const lowerDOI = cleanDOI.toLowerCase();
                const existing = doiMap.get(lowerDOI) || [];
                existing.push(item.id);
                doiMap.set(lowerDOI, existing);
            }
        }

        if (item.data.ISBN) {
            const cleanISBN = Zotero.Utilities.cleanISBN(String(item.data.ISBN));
            if (cleanISBN) {
                const existing = isbnMap.get(cleanISBN) || [];
                existing.push(item.id);
                isbnMap.set(cleanISBN, existing);
            }
        }

        if (item.data.title) {
            needsFuzzyMatch.push(item);
        }
    }

    return { doiMap, isbnMap, needsFuzzyMatch };
}

/**
 * Phase 1: Batch lookup by DOI and ISBN.
 * DOI and ISBN queries are dispatched concurrently at the JS layer; SQLite
 * serializes them but this keeps the call shape simple.
 */
async function batchFindByIdentifiers(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<Map<string, ZoteroItemReference>> {
    const results = new Map<string, ZoteroItemReference>();
    if (items.length === 0 || libraryIds.length === 0) return results;

    const { doiMap, isbnMap } = cleanIdentifiers(items);
    const doiFieldID = Zotero.ItemFields.getID('DOI');
    const isbnFieldID = Zotero.ItemFields.getID('ISBN');
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');

    const doiPromise = (async () => {
        if (!(doiMap.size > 0 && doiFieldID)) return;
        const doisLower = Array.from(doiMap.keys());
        const doiPlaceholders = doisLower.map(() => '?').join(', ');

        // COLLATE NOCASE handles DOIs stored with mixed casing (DOIs are
        // ASCII, so NOCASE is correct). It does NOT use the BINARY UNIQUE
        // index on itemDataValues.value — NOCASE comparison is incompatible
        // with a BINARY-collated index — but the query plan drives through
        // itemData_fieldID anyway, and Phase 1 is not the hot path.
        const sql = `
            SELECT i.itemID, i.libraryID, i.key, idv.value as doi
            FROM items i
            JOIN itemData id ON i.itemID = id.itemID
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            LEFT JOIN deletedItems di ON i.itemID = di.itemID
            WHERE i.libraryID IN (${libraryPlaceholders})
            AND id.fieldID = ?
            AND idv.value COLLATE NOCASE IN (${doiPlaceholders})
            AND di.itemID IS NULL
        `;

        try {
            const params = [...libraryIds, doiFieldID, ...doisLower];
            const doiRows: { library_id: number; zotero_key: string; doi: string }[] = [];
            await Zotero.DB.queryAsync(sql, params, {
                onRow: (row: any) => {
                    doiRows.push({
                        library_id: row.getResultByIndex(1),
                        zotero_key: row.getResultByIndex(2),
                        doi: row.getResultByIndex(3)
                    });
                }
            });

            logger(`batchFindByIdentifiers: DOI query returned ${doiRows.length} rows for ${doisLower.length} DOIs`, 1);

            for (const row of doiRows) {
                const cleanDOI = Zotero.Utilities.cleanDOI(row.doi);
                if (cleanDOI) {
                    const requestItemIds = doiMap.get(cleanDOI.toLowerCase());
                    if (requestItemIds) {
                        for (const requestItemId of requestItemIds) {
                            if (!results.has(requestItemId)) {
                                results.set(requestItemId, { library_id: row.library_id, zotero_key: row.zotero_key });
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger(`batchFindByIdentifiers: DOI batch query failed: ${error}`, 1);
        }
    })();

    const isbnPromise = (async () => {
        if (!(isbnMap.size > 0 && isbnFieldID)) return;
        const isbnLikeClauses = Array.from(isbnMap.keys()).map(() => `REPLACE(REPLACE(idv.value, '-', ''), ' ', '') LIKE ?`);
        const isbnLikeParams = Array.from(isbnMap.keys()).map(isbn => `%${isbn}%`);

        const sql = `
            SELECT i.itemID, i.libraryID, i.key, idv.value as isbn
            FROM items i
            JOIN itemData id ON i.itemID = id.itemID
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            LEFT JOIN deletedItems di ON i.itemID = di.itemID
            WHERE i.libraryID IN (${libraryPlaceholders})
            AND id.fieldID = ?
            AND (${isbnLikeClauses.join(' OR ')})
            AND di.itemID IS NULL
        `;

        try {
            const params = [...libraryIds, isbnFieldID, ...isbnLikeParams];
            const matchedRows: { library_id: number; zotero_key: string; cleanISBN: string }[] = [];
            await Zotero.DB.queryAsync(sql, params, {
                onRow: (row: any) => {
                    const dbISBN = row.getResultByIndex(3);
                    const cleanISBN = Zotero.Utilities.cleanISBN(String(dbISBN));
                    if (cleanISBN && isbnMap.has(cleanISBN)) {
                        matchedRows.push({
                            library_id: row.getResultByIndex(1),
                            zotero_key: row.getResultByIndex(2),
                            cleanISBN
                        });
                    }
                }
            });

            for (const row of matchedRows) {
                const requestItemIds = isbnMap.get(row.cleanISBN);
                if (requestItemIds) {
                    for (const requestItemId of requestItemIds) {
                        if (!results.has(requestItemId)) {
                            results.set(requestItemId, { library_id: row.library_id, zotero_key: row.zotero_key });
                        }
                    }
                }
            }
        } catch (error) {
            logger(`batchFindByIdentifiers: ISBN batch query failed: ${error}`, 1);
        }
    })();

    await Promise.all([doiPromise, isbnPromise]);
    return results;
}

/**
 * Phase 2 setup — normalize input titles and figure out which field IDs
 * to search against.
 */
function prepareTitleSearch(items: BatchReferenceCheckItem[]) {
    const needsMatching = items.filter(item => item.data.title);

    const titleFieldID = Zotero.ItemFields.getID('title');
    const mappedTitleFieldIDs = titleFieldID ? Zotero.ItemFields.getTypeFieldsFromBase('title') : [];
    const allTitleFieldIDs = titleFieldID ? [titleFieldID, ...(mappedTitleFieldIDs || [])] : [];

    // Map normalized title -> input items (multiple inputs can share a normalized title)
    const normalizedInputTitles = new Map<string, BatchReferenceCheckItem[]>();
    for (const item of needsMatching) {
        const normalized = normalizeString(item.data.title);
        if (normalized) {
            const existing = normalizedInputTitles.get(normalized) || [];
            existing.push(item);
            normalizedInputTitles.set(normalized, existing);
        }
    }

    // Original-case title strings to pass into the exact-match SQL IN().
    // We .trim() input but not DB values — if a DB row has leading/trailing
    // whitespace (rare, can come from imports) the BINARY equality in 2a
    // misses it. 2b's keyword LIKE picks those up, so correctness is
    // preserved.
    const originalTitleStrings = new Set<string>();
    for (const entries of normalizedInputTitles.values()) {
        for (const it of entries) {
            const t = it.data.title;
            if (t) originalTitleStrings.add(t.trim());
        }
    }

    return { needsMatching, titleFieldID, allTitleFieldIDs, normalizedInputTitles, originalTitleStrings };
}

type TitleMatchRow = { itemID: number; libraryID: number; key: string; normalizedTitle: string };

/**
 * Phase 2a: Exact-value title fast path.
 *
 * Uses BINARY equality on itemDataValues.value (UNIQUE-indexed) to find
 * candidate valueIDs for the given input titles, then joins through
 * itemData and items. This uses the value index and avoids scanning every
 * title in the library.
 *
 * Case sensitivity: BINARY equality misses titles that differ only in case.
 * Those fall through to the keyword LIKE path in Phase 2b.
 */
async function batchFindTitleByExactValue(
    allTitleFieldIDs: number[],
    libraryIds: number[],
    normalizedInputTitles: Map<string, BatchReferenceCheckItem[]>,
    originalTitleStrings: Set<string>
): Promise<TitleMatchRow[]> {
    const rows: TitleMatchRow[] = [];
    if (originalTitleStrings.size === 0 || libraryIds.length === 0 || allTitleFieldIDs.length === 0) {
        return rows;
    }

    const noteTypeID = Zotero.ItemTypes.getID('note') || 28;
    const attachmentTypeID = Zotero.ItemTypes.getID('attachment') || 3;
    const annotationTypeID = Zotero.ItemTypes.getID('annotation') || 1;

    const titles = Array.from(originalTitleStrings);
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');
    const titleFieldPlaceholders = allTitleFieldIDs.map(() => '?').join(', ');

    for (let i = 0; i < titles.length; i += SQL_CHUNK_SIZE) {
        const chunk = titles.slice(i, i + SQL_CHUNK_SIZE);
        const valuePlaceholders = chunk.map(() => '?').join(', ');

        const sql = `
            SELECT i.itemID, i.libraryID, i.key, idv.value as title
            FROM itemDataValues idv
            JOIN itemData id ON id.valueID = idv.valueID AND id.fieldID IN (${titleFieldPlaceholders})
            JOIN items i ON i.itemID = id.itemID
            LEFT JOIN deletedItems di ON i.itemID = di.itemID
            WHERE idv.value IN (${valuePlaceholders})
              AND i.libraryID IN (${libraryPlaceholders})
              AND di.itemID IS NULL
              AND i.itemTypeID NOT IN (?, ?, ?)
        `;
        const params = [...allTitleFieldIDs, ...chunk, ...libraryIds, noteTypeID, attachmentTypeID, annotationTypeID];

        await Zotero.DB.queryAsync(sql, params, {
            onRow: (row: any) => {
                const itemID = row.getResultByIndex(0);
                const libraryID = row.getResultByIndex(1);
                const key = row.getResultByIndex(2);
                const title = row.getResultByIndex(3);
                const normalized = normalizeString(title);
                if (normalized && normalizedInputTitles.has(normalized)) {
                    rows.push({ itemID, libraryID, key, normalizedTitle: normalized });
                }
            }
        });
    }

    return rows;
}

/**
 * Phase 2b: Keyword LIKE scan.
 *
 * Runs for normalized input title. Each input title contributes a single keyword
 * (longest ASCII word) to keep the OR clause count small. LOWER(title) LIKE '%kw%'
 * catches diacritic / casing / punctuation / whitespace mismatches.
 *
 * Title-only SELECT (no LEFT JOINs to DOI/ISBN/date) keeps this query
 * simple; meta is fetched for matched itemIDs separately.
 */
async function batchFindTitleByKeyword(
    allTitleFieldIDs: number[],
    libraryIds: number[],
    normalizedInputTitles: Map<string, BatchReferenceCheckItem[]>
): Promise<TitleMatchRow[]> {
    const rows: TitleMatchRow[] = [];
    if (normalizedInputTitles.size === 0 || libraryIds.length === 0 || allTitleFieldIDs.length === 0) {
        return rows;
    }

    // One keyword per input title (longest ASCII word)
    const titleKeywordSets: string[][] = [];
    for (const entries of normalizedInputTitles.values()) {
        const originalTitle = entries[0].data.title;
        if (originalTitle) {
            const keywords = extractFilterKeywords(originalTitle, 1);
            if (keywords.length > 0) titleKeywordSets.push(keywords);
        }
    }
    if (titleKeywordSets.length === 0) return rows;

    const noteTypeID = Zotero.ItemTypes.getID('note') || 28;
    const attachmentTypeID = Zotero.ItemTypes.getID('attachment') || 3;
    const annotationTypeID = Zotero.ItemTypes.getID('annotation') || 1;

    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');
    const titleFieldPlaceholders = allTitleFieldIDs.map(() => '?').join(', ');

    let sql = `
        SELECT DISTINCT i.itemID, i.libraryID, i.key, title_val.value as title
        FROM items i
        JOIN itemData title_data ON i.itemID = title_data.itemID AND title_data.fieldID IN (${titleFieldPlaceholders})
        JOIN itemDataValues title_val ON title_data.valueID = title_val.valueID
        LEFT JOIN deletedItems di ON i.itemID = di.itemID
        WHERE i.libraryID IN (${libraryPlaceholders})
        AND di.itemID IS NULL
        AND i.itemTypeID NOT IN (?, ?, ?)
    `;

    const params: (string | number)[] = [
        ...allTitleFieldIDs,
        ...libraryIds,
        noteTypeID, attachmentTypeID, annotationTypeID
    ];

    const orClauses: string[] = [];
    for (const keywords of titleKeywordSets) {
        const andParts = keywords.map(kw => {
            params.push(`%${kw}%`);
            return `LOWER(title_val.value) LIKE ?`;
        });
        orClauses.push(`(${andParts.join(' AND ')})`);
    }
    sql += ` AND (${orClauses.join(' OR ')})`;

    let totalRows = 0;
    await Zotero.DB.queryAsync(sql, params, {
        onRow: (row: any) => {
            totalRows++;
            const itemID = row.getResultByIndex(0);
            const libraryID = row.getResultByIndex(1);
            const key = row.getResultByIndex(2);
            const title = row.getResultByIndex(3);
            const normalized = normalizeString(title);
            if (normalized && normalizedInputTitles.has(normalized)) {
                rows.push({ itemID, libraryID, key, normalizedTitle: normalized });
            }
        }
    });

    logger(`batchFindTitleByKeyword: scanned ${totalRows} pre-filtered rows, matched ${rows.length} after normalization`, 1);
    return rows;
}

/**
 * Phase 2c — fetch DOI / ISBN / date metadata for a set of itemIDs.
 */
async function fetchMetaForItems(
    itemIDs: number[]
): Promise<Map<number, { doi: string | null; isbn: string | null; date: string | null }>> {
    const result = new Map<number, { doi: string | null; isbn: string | null; date: string | null }>();
    if (itemIDs.length === 0) return result;

    const doiFieldID = Zotero.ItemFields.getID('DOI');
    const isbnFieldID = Zotero.ItemFields.getID('ISBN');
    const dateFieldID = Zotero.ItemFields.getID('date');
    const mappedDateFieldIDs = dateFieldID ? Zotero.ItemFields.getTypeFieldsFromBase('date') : [];
    const allDateFieldIDs = dateFieldID ? [dateFieldID, ...(mappedDateFieldIDs || [])] : [];

    const metaFieldIDs: number[] = [];
    if (doiFieldID) metaFieldIDs.push(doiFieldID);
    if (isbnFieldID) metaFieldIDs.push(isbnFieldID);
    metaFieldIDs.push(...allDateFieldIDs);

    if (metaFieldIDs.length === 0) return result;

    for (const id of itemIDs) result.set(id, { doi: null, isbn: null, date: null });

    for (let i = 0; i < itemIDs.length; i += SQL_CHUNK_SIZE) {
        const chunk = itemIDs.slice(i, i + SQL_CHUNK_SIZE);
        const itemPlaceholders = chunk.map(() => '?').join(', ');
        const fieldPlaceholders = metaFieldIDs.map(() => '?').join(', ');

        const sql = `
            SELECT id.itemID, id.fieldID, idv.value
            FROM itemData id
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            WHERE id.itemID IN (${itemPlaceholders})
              AND id.fieldID IN (${fieldPlaceholders})
        `;
        const params = [...chunk, ...metaFieldIDs];

        await Zotero.DB.queryAsync(sql, params, {
            onRow: (row: any) => {
                const itemID = row.getResultByIndex(0);
                const fieldID = row.getResultByIndex(1);
                const value = row.getResultByIndex(2);
                const meta = result.get(itemID);
                if (!meta) return;
                if (fieldID === doiFieldID) {
                    meta.doi = value;
                } else if (fieldID === isbnFieldID) {
                    meta.isbn = value;
                } else if (dateFieldID && fieldID === dateFieldID) {
                    // Base 'date' field always wins over mapped date fields.
                    meta.date = value;
                } else if (meta.date == null) {
                    // Mapped date field (e.g. filingDate, issueDate) — only
                    // used if the base 'date' hasn't been seen yet, and
                    // still deterministic because a base 'date' arriving
                    // later will overwrite this.
                    meta.date = value;
                }
            }
        });
    }

    return result;
}

/**
 * Phase 2c — fetch creator last names for a set of itemIDs.
 */
async function fetchCreatorsForItems(itemIDs: number[]): Promise<Map<number, string[]>> {
    const creatorMap = new Map<number, string[]>();
    if (itemIDs.length === 0) return creatorMap;

    for (let i = 0; i < itemIDs.length; i += SQL_CHUNK_SIZE) {
        const chunk = itemIDs.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const creatorSql = `
            SELECT ic.itemID, c.lastName
            FROM itemCreators ic
            JOIN creators c ON ic.creatorID = c.creatorID
            WHERE ic.itemID IN (${placeholders})
            ORDER BY ic.itemID, ic.orderIndex
        `;
        await Zotero.DB.queryAsync(creatorSql, chunk, {
            onRow: (row: any) => {
                const itemID = row.getResultByIndex(0);
                const lastName = row.getResultByIndex(1);
                if (!creatorMap.has(itemID)) creatorMap.set(itemID, []);
                creatorMap.get(itemID)!.push(lastName || '');
            }
        });
    }

    return creatorMap;
}

/**
 * Phase 2: batch collection of title candidates for items not resolved in Phase 1.
 */
async function batchFindTitleCandidates(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<Map<number, TitleCandidate>> {
    const candidates = new Map<number, TitleCandidate>();

    const { needsMatching, titleFieldID, allTitleFieldIDs, normalizedInputTitles, originalTitleStrings } =
        prepareTitleSearch(items);

    if (needsMatching.length === 0 || libraryIds.length === 0 || !titleFieldID || normalizedInputTitles.size === 0) {
        return candidates;
    }

    // 2a. Exact-match fast path — quick lookups for the common case where
    // the input title matches the DB title byte-for-byte.
    const exactRows = await batchFindTitleByExactValue(
        allTitleFieldIDs, libraryIds, normalizedInputTitles, originalTitleStrings
    );

    // 2b. Keyword LIKE scan — runs for EVERY normalized input title, not
    // just titles missed by 2a. 2a can return a "wrong" candidate (title
    // exact-match but Phase 3 rejects it on DOI/year/creator) and if we
    // suppressed 2b for that title we'd miss a correct candidate whose
    // stored title differs only in case/whitespace. Dedup on itemID below.
    const likeRows = await batchFindTitleByKeyword(
        allTitleFieldIDs, libraryIds, normalizedInputTitles
    );

    logger(`batchFindTitleCandidates: 2a returned ${exactRows.length} exact rows, 2b returned ${likeRows.length} LIKE rows across ${normalizedInputTitles.size} input titles`, 1);

    const allRows: TitleMatchRow[] = [...exactRows];
    const seenItemIDs = new Set<number>(exactRows.map(r => r.itemID));
    for (const r of likeRows) {
        if (!seenItemIDs.has(r.itemID)) {
            seenItemIDs.add(r.itemID);
            allRows.push(r);
        }
    }

    if (allRows.length === 0) return candidates;

    const candidateItemIDs = allRows.map(r => r.itemID);

    // 2c. Fetch meta + creators for all candidates (can't run in parallel —
    // SQLite serializes anyway, and Promise.all masks real timings).
    const meta = await fetchMetaForItems(candidateItemIDs);
    const creatorMap = await fetchCreatorsForItems(candidateItemIDs);

    for (const row of allRows) {
        const m = meta.get(row.itemID) || { doi: null, isbn: null, date: null };
        candidates.set(row.itemID, {
            libraryID: row.libraryID,
            key: row.key,
            normalizedTitle: row.normalizedTitle,
            doi: m.doi,
            isbn: m.isbn,
            date: m.date,
            creatorLastNames: creatorMap.get(row.itemID) || []
        });
    }

    return candidates;
}

function findMatchInCandidates(
    inputItem: BatchReferenceCheckItem,
    candidates: Map<number, TitleCandidate>
): TitleCandidate | null {
    const normalizedInputTitle = normalizeString(inputItem.data.title);
    if (!normalizedInputTitle) return null;

    let inputYear: number | null = null;
    if (inputItem.data.date) {
        const parsedDate = Zotero.Date.strToDate(inputItem.data.date);
        inputYear = parseYear(parsedDate.year);
    }
    const inputCreators = inputItem.data.creators || [];
    const cleanInputDOI = inputItem.data.DOI ? Zotero.Utilities.cleanDOI(inputItem.data.DOI) : null;
    const cleanInputISBN = inputItem.data.ISBN ? Zotero.Utilities.cleanISBN(String(inputItem.data.ISBN)) : null;

    for (const [, candidate] of candidates) {
        if (candidate.normalizedTitle !== normalizedInputTitle) continue;

        const candidateDOI = candidate.doi ? Zotero.Utilities.cleanDOI(candidate.doi) : null;
        if (cleanInputDOI && candidateDOI && cleanInputDOI !== candidateDOI) continue;

        const candidateISBN = candidate.isbn ? Zotero.Utilities.cleanISBN(String(candidate.isbn)) : null;
        if (cleanInputISBN && candidateISBN && cleanInputISBN !== candidateISBN) continue;

        let candidateYear: number | null = null;
        if (candidate.date) {
            const parsedDate = Zotero.Date.strToDate(candidate.date);
            candidateYear = parseYear(parsedDate.year);
        }
        if (inputYear && candidateYear && Math.abs(inputYear - candidateYear) > 1) continue;

        const candidateCreatorLastNames = candidate.creatorLastNames;
        if (inputCreators.length === 0 && candidateCreatorLastNames.length === 0) return candidate;
        if (inputCreators.length === 0 || candidateCreatorLastNames.length === 0) continue;

        let creatorMatch = false;
        outerLoop:
        for (const inputCreatorLast of inputCreators) {
            const inputLast = normalizeString(inputCreatorLast);
            if (!inputLast) continue;
            for (const candLastName of candidateCreatorLastNames) {
                const candLast = normalizeString(candLastName);
                if (!candLast) continue;
                if (inputLast === candLast) {
                    creatorMatch = true;
                    break outerLoop;
                }
            }
        }
        if (!creatorMatch) continue;

        return candidate;
    }

    return null;
}

/**
 * Batch find existing references across multiple libraries.
 */
export async function batchFindExistingReferences(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<{ results: BatchReferenceCheckResult[]; timing: BatchReferenceCheckTiming }> {
    const startTime = Date.now();

    const emptyTiming: BatchReferenceCheckTiming = {
        total_ms: 0,
        phase1_identifier_lookup_ms: 0,
        phase2_title_candidates_ms: 0,
        phase3_fuzzy_matching_ms: 0,
        candidates_fetched: 0,
        matches_by_identifier: 0,
        matches_by_fuzzy: 0,
    };

    if (items.length === 0) {
        return { results: [], timing: emptyTiming };
    }

    if (libraryIds.length === 0) {
        return {
            results: items.map(item => ({ id: item.id, item: null })),
            timing: { ...emptyTiming, total_ms: Date.now() - startTime }
        };
    }

    logger(`batchFindExistingReferences: Checking ${items.length} items across ${libraryIds.length} libraries`, 1);

    const results = new Map<string, ZoteroItemReference | null>();
    for (const item of items) results.set(item.id, null);

    // Phase 1 — identifier match
    const phase1Start = Date.now();
    const identifierMatches = await batchFindByIdentifiers(items, libraryIds);
    const phase1Time = Date.now() - phase1Start;

    for (const [itemId, ref] of identifierMatches) results.set(itemId, ref);
    const foundByIdentifier = identifierMatches.size;

    // Phase 2 — title match only for items not resolved by Phase 1
    const phase2Start = Date.now();
    const unresolvedItems = items.filter(item => results.get(item.id) == null);
    const titleCandidates = unresolvedItems.length > 0
        ? await batchFindTitleCandidates(unresolvedItems, libraryIds)
        : new Map<number, TitleCandidate>();
    const phase2Time = Date.now() - phase2Start;

    logger(`batchFindExistingReferences: Phase1=${phase1Time}ms (${foundByIdentifier} matched), Phase2=${phase2Time}ms (${titleCandidates.size} candidates for ${unresolvedItems.length} unresolved)`, 1);

    // Phase 3 — in-memory fuzzy match
    const phase3Start = Date.now();
    let fuzzyMatches = 0;
    for (const item of unresolvedItems) {
        if (!item.data.title) continue;
        const match = findMatchInCandidates(item, titleCandidates);
        if (match) {
            results.set(item.id, { library_id: match.libraryID, zotero_key: match.key });
            fuzzyMatches++;
        }
    }
    const phase3Time = Date.now() - phase3Start;

    const totalTime = Date.now() - startTime;
    logger(`batchFindExistingReferences: Completed in ${totalTime}ms. Found ${foundByIdentifier} by identifier, ${fuzzyMatches} by fuzzy match`, 1);

    const timing: BatchReferenceCheckTiming = {
        total_ms: totalTime,
        phase1_identifier_lookup_ms: phase1Time,
        phase2_title_candidates_ms: phase2Time,
        phase3_fuzzy_matching_ms: phase3Time,
        candidates_fetched: titleCandidates.size,
        matches_by_identifier: foundByIdentifier,
        matches_by_fuzzy: fuzzyMatches,
    };

    const resultArray: BatchReferenceCheckResult[] = items.map(item => ({
        id: item.id,
        item: results.get(item.id) || null
    }));

    return { results: resultArray, timing };
}
