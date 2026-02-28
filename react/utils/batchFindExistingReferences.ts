/**
 * Batch Reference Finder
 * 
 * Optimized batch lookup for checking if multiple external references exist in Zotero.
 * Uses batch SQL queries instead of per-reference queries for much better performance.
 * 
 * Performance improvement: Reduces N×L×3 queries to approximately 5-10 queries total.
 */

import { FindReferenceData } from './findExistingReference';
import { ZoteroItemReference } from '../types/zotero';
import { logger } from '../../src/utils/logger';

/**
 * Lightweight representation of a title-matched candidate from Zotero DB.
 * Replaces full Zotero.Item objects to avoid expensive getAsync/loadDataTypes calls.
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
    /** Total operation time in milliseconds */
    total_ms: number;
    /** Time spent in phase 1: identifier (DOI/ISBN) lookup */
    phase1_identifier_lookup_ms: number;
    /** Time spent in phase 2: fetching title candidates */
    phase2_title_candidates_ms: number;
    /** Time spent in phase 3: fuzzy matching */
    phase3_fuzzy_matching_ms: number;
    /** Number of title candidates fetched from database */
    candidates_fetched: number;
    /** Number of matches found by identifiers */
    matches_by_identifier: number;
    /** Number of matches found by fuzzy matching */
    matches_by_fuzzy: number;
}

/**
 * Normalize a string for comparison using Zotero's duplicate detection logic
 */
function normalizeString(str: string | undefined | null): string {
    const s = str ? str + "" : "";
    if (s === "") return "";
    
    return Zotero.Utilities.removeDiacritics(s)
        .replace(/[ !-/:-@[-`{-~]+/g, ' ') // Convert (ASCII) punctuation to spaces
        .trim()
        .toLowerCase();
}

/**
 * Safely parse a year from a string, returning null if invalid
 */
function parseYear(yearStr: string | undefined | null): number | null {
    if (!yearStr) return null;
    const parsed = parseInt(String(yearStr));
    return isNaN(parsed) ? null : parsed;
}

/**
 * Clean and normalize identifiers for batch lookup
 */
function cleanIdentifiers(items: BatchReferenceCheckItem[]): {
    doiMap: Map<string, string[]>;  // cleanDOI (lowercase) -> item IDs that have this DOI
    isbnMap: Map<string, string[]>; // cleanISBN -> item IDs that have this ISBN
    needsFuzzyMatch: BatchReferenceCheckItem[]; // Items that need fuzzy matching
} {
    const doiMap = new Map<string, string[]>();
    const isbnMap = new Map<string, string[]>();
    const needsFuzzyMatch: BatchReferenceCheckItem[] = [];
    
    for (const item of items) {
        let hasIdentifier = false;
        
        // Clean and collect DOI (stored lowercase for case-insensitive matching)
        if (item.data.DOI) {
            const cleanDOI = Zotero.Utilities.cleanDOI(item.data.DOI);
            if (cleanDOI) {
                hasIdentifier = true;
                const lowerDOI = cleanDOI.toLowerCase();
                const existing = doiMap.get(lowerDOI) || [];
                existing.push(item.id);
                doiMap.set(lowerDOI, existing);
            }
        }
        
        // Clean and collect ISBN (ISBNs are numeric, no case sensitivity needed)
        if (item.data.ISBN) {
            const cleanISBN = Zotero.Utilities.cleanISBN(String(item.data.ISBN));
            if (cleanISBN) {
                hasIdentifier = true;
                const existing = isbnMap.get(cleanISBN) || [];
                existing.push(item.id);
                isbnMap.set(cleanISBN, existing);
            }
        }
        
        // Track items that might need fuzzy matching (even if they have identifiers,
        // we need to try fuzzy if identifier lookup fails)
        if (item.data.title) {
            needsFuzzyMatch.push(item);
        }
    }
    
    return { doiMap, isbnMap, needsFuzzyMatch };
}

/**
 * Phase 1: Batch lookup by DOI and ISBN
 * Returns a map of request item ID -> lightweight reference (libraryID + key).
 * DOI and ISBN queries run in parallel. No Zotero.Items.getAsync() needed —
 * libraryID and key are selected directly from the items table.
 */
async function batchFindByIdentifiers(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<Map<string, ZoteroItemReference>> {
    const results = new Map<string, ZoteroItemReference>();

    if (items.length === 0 || libraryIds.length === 0) {
        return results;
    }

    const { doiMap, isbnMap } = cleanIdentifiers(items);

    // Cache field IDs
    const doiFieldID = Zotero.ItemFields.getID('DOI');
    const isbnFieldID = Zotero.ItemFields.getID('ISBN');

    // Build library placeholders
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');

    // Run DOI and ISBN queries in parallel
    const doiPromise = (async () => {
        if (!(doiMap.size > 0 && doiFieldID)) return;

        const doisLower = Array.from(doiMap.keys()).map(d => d.toLowerCase());
        const doiPlaceholders = doisLower.map(() => '?').join(', ');

        const sql = `
            SELECT i.itemID, i.libraryID, i.key, idv.value as doi
            FROM items i
            JOIN itemData id ON i.itemID = id.itemID
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            LEFT JOIN deletedItems di ON i.itemID = di.itemID
            WHERE i.libraryID IN (${libraryPlaceholders})
            AND id.fieldID = ?
            AND LOWER(idv.value) IN (${doiPlaceholders})
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
 * Extract discriminating keywords from a title for SQL LIKE pre-filtering.
 * Prefers ASCII-only words — they match reliably across diacritics variants
 * in LOWER()+LIKE. Non-ASCII words (é, ü, etc.) can mismatch when DB and
 * input disagree on diacritics (e.g. "etudes" vs "études").
 *
 * Falls back to non-ASCII words when not enough ASCII words are available.
 */
function extractFilterKeywords(title: string, maxKeywords: number = 2): string[] {
    const lowered = (title + "")
        .replace(/[ !-/:-@[-`{-~]+/g, ' ') // Same punctuation → space as normalizeString
        .trim()
        .toLowerCase();
    const words = lowered.split(/\s+/).filter(w => w.length >= 2);
    // Sort by length descending — longer words are more discriminating
    words.sort((a, b) => b.length - a.length);
    // Prefer ASCII-only words — they match reliably across diacritics variants
    const ascii = words.filter(w => /^[\x20-\x7e]+$/.test(w));
    const nonAscii = words.filter(w => !/^[\x20-\x7e]+$/.test(w));
    const result = [...ascii.slice(0, maxKeywords)];
    if (result.length < maxKeywords) {
        result.push(...nonAscii.slice(0, maxKeywords - result.length));
    }
    return result;
}

/**
 * Shared setup for Phase 2: extracts normalized titles and keyword sets from input items.
 * Used by both the fast SQL path and the fallback path.
 */
function prepareTitleSearch(items: BatchReferenceCheckItem[]) {
    const needsMatching = items.filter(item => item.data.title);

    const titleFieldID = Zotero.ItemFields.getID('title');
    const mappedTitleFieldIDs = titleFieldID ? Zotero.ItemFields.getTypeFieldsFromBase('title') : [];
    const allTitleFieldIDs = titleFieldID ? [titleFieldID, ...(mappedTitleFieldIDs || [])] : [];

    // Build normalized title map
    const normalizedInputTitles = new Map<string, BatchReferenceCheckItem[]>();
    for (const item of needsMatching) {
        const normalized = normalizeString(item.data.title);
        if (normalized) {
            const existing = normalizedInputTitles.get(normalized) || [];
            existing.push(item);
            normalizedInputTitles.set(normalized, existing);
        }
    }

    // Extract keywords for SQL pre-filtering
    const titleKeywordSets: string[][] = [];
    for (const titleItems of normalizedInputTitles.values()) {
        const originalTitle = titleItems[0].data.title;
        if (originalTitle) {
            const keywords = extractFilterKeywords(originalTitle);
            if (keywords.length > 0) {
                titleKeywordSets.push(keywords);
            }
        }
    }

    return { needsMatching, titleFieldID, allTitleFieldIDs, normalizedInputTitles, titleKeywordSets };
}

/**
 * Build the base title SQL query with keyword LIKE pre-filtering.
 * Returns { sql, params } for the SELECT clause up to the WHERE conditions.
 */
function buildTitleSqlBase(
    allTitleFieldIDs: number[],
    libraryIds: number[],
    titleKeywordSets: string[][],
    extraSelectColumns: string,
    extraJoins: string,
    extraParams: (string | number)[]
): { sql: string; params: (string | number)[] } {
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');
    const titlePlaceholders = allTitleFieldIDs.map(() => '?').join(', ');

    // Non-regular item types to exclude: annotation (1), attachment (3), note (28)
    const noteTypeID = Zotero.ItemTypes.getID('note') || 28;
    const attachmentTypeID = Zotero.ItemTypes.getID('attachment') || 3;
    const annotationTypeID = Zotero.ItemTypes.getID('annotation') || 1;

    let sql = `
        SELECT DISTINCT i.itemID, i.libraryID, i.key, title_val.value as title${extraSelectColumns}
        FROM items i
        JOIN itemData title_data ON i.itemID = title_data.itemID AND title_data.fieldID IN (${titlePlaceholders})
        JOIN itemDataValues title_val ON title_data.valueID = title_val.valueID
        LEFT JOIN deletedItems di ON i.itemID = di.itemID
        ${extraJoins}
        WHERE i.libraryID IN (${libraryPlaceholders})
        AND di.itemID IS NULL
        AND i.itemTypeID NOT IN (?, ?, ?)
    `;

    const params: (string | number)[] = [
        ...allTitleFieldIDs,
        ...extraParams,
        ...libraryIds,
        noteTypeID, attachmentTypeID, annotationTypeID
    ];

    // Add keyword LIKE filter to avoid scanning all titles
    if (titleKeywordSets.length > 0) {
        const orClauses: string[] = [];
        for (const keywords of titleKeywordSets) {
            const andParts = keywords.map(kw => {
                params.push(`%${kw}%`);
                return `LOWER(title_val.value) LIKE ?`;
            });
            orClauses.push(`(${andParts.join(' AND ')})`);
        }
        sql += ` AND (${orClauses.join(' OR ')})`;
    }

    return { sql, params };
}

/**
 * Fast SQL path for Phase 2: fetches all candidate data via pure SQL.
 * Avoids Zotero.Items.getAsync() and loadDataTypes() entirely.
 */
async function batchFindTitleCandidatesFast(
    allTitleFieldIDs: number[],
    libraryIds: number[],
    normalizedInputTitles: Map<string, BatchReferenceCheckItem[]>,
    titleKeywordSets: string[][]
): Promise<Map<number, TitleCandidate>> {
    // Look up field IDs for DOI, ISBN, date
    const doiFieldID = Zotero.ItemFields.getID('DOI');
    const isbnFieldID = Zotero.ItemFields.getID('ISBN');
    const dateFieldID = Zotero.ItemFields.getID('date');
    const mappedDateFieldIDs = dateFieldID ? Zotero.ItemFields.getTypeFieldsFromBase('date') : [];
    const allDateFieldIDs = dateFieldID ? [dateFieldID, ...(mappedDateFieldIDs || [])] : [];

    // Build extra SELECT columns and LEFT JOINs for DOI, ISBN, date
    let extraSelectColumns = '';
    let extraJoins = '';
    const extraParams: (string | number)[] = [];

    if (doiFieldID) {
        extraSelectColumns += `, doi_val.value as doi`;
        extraJoins += `
        LEFT JOIN itemData doi_data ON i.itemID = doi_data.itemID AND doi_data.fieldID = ?
        LEFT JOIN itemDataValues doi_val ON doi_data.valueID = doi_val.valueID`;
        extraParams.push(doiFieldID);
    } else {
        extraSelectColumns += `, NULL as doi`;
    }

    if (isbnFieldID) {
        extraSelectColumns += `, isbn_val.value as isbn`;
        extraJoins += `
        LEFT JOIN itemData isbn_data ON i.itemID = isbn_data.itemID AND isbn_data.fieldID = ?
        LEFT JOIN itemDataValues isbn_val ON isbn_data.valueID = isbn_val.valueID`;
        extraParams.push(isbnFieldID);
    } else {
        extraSelectColumns += `, NULL as isbn`;
    }

    if (allDateFieldIDs.length > 0) {
        const datePlaceholders = allDateFieldIDs.map(() => '?').join(', ');
        extraSelectColumns += `, date_val.value as date_value`;
        extraJoins += `
        LEFT JOIN itemData date_data ON i.itemID = date_data.itemID AND date_data.fieldID IN (${datePlaceholders})
        LEFT JOIN itemDataValues date_val ON date_data.valueID = date_val.valueID`;
        extraParams.push(...allDateFieldIDs);
    } else {
        extraSelectColumns += `, NULL as date_value`;
    }

    const { sql, params } = buildTitleSqlBase(
        allTitleFieldIDs, libraryIds, titleKeywordSets,
        extraSelectColumns, extraJoins, extraParams
    );

    logger(`batchFindTitleCandidatesFast: Searching ${normalizedInputTitles.size} titles with ${titleKeywordSets.length} keyword sets across ${libraryIds.length} libraries`, 1);

    // Query 1: Fetch title candidates with DOI, ISBN, date
    const matchingRows: {
        itemID: number; libraryID: number; key: string;
        normalizedTitle: string; doi: string | null;
        isbn: string | null; date: string | null;
    }[] = [];
    let totalRows = 0;

    await Zotero.DB.queryAsync(sql, params, {
        onRow: (row: any) => {
            totalRows++;
            const itemID = row.getResultByIndex(0);
            const libraryID = row.getResultByIndex(1);
            const key = row.getResultByIndex(2);
            const title = row.getResultByIndex(3);
            const doi = row.getResultByIndex(4) || null;
            const isbn = row.getResultByIndex(5) || null;
            const dateValue = row.getResultByIndex(6) || null;
            const normalizedDbTitle = normalizeString(title);
            if (normalizedDbTitle && normalizedInputTitles.has(normalizedDbTitle)) {
                matchingRows.push({
                    itemID, libraryID, key, normalizedTitle: normalizedDbTitle,
                    doi, isbn, date: dateValue
                });
            }
        }
    });

    logger(`batchFindTitleCandidatesFast: SQL returned ${totalRows} pre-filtered rows, found ${matchingRows.length} exact normalized matches`, 1);

    if (matchingRows.length === 0) {
        return new Map();
    }

    // Query 2: Fetch creator last names for matched items
    const matchedItemIDs = matchingRows.map(r => r.itemID);
    const creatorMap = new Map<number, string[]>();

    // Batch in chunks of 500 to avoid SQLite variable limits
    for (let i = 0; i < matchedItemIDs.length; i += 500) {
        const chunk = matchedItemIDs.slice(i, i + 500);
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
                if (!creatorMap.has(itemID)) {
                    creatorMap.set(itemID, []);
                }
                creatorMap.get(itemID)!.push(lastName || '');
            }
        });
    }

    // Build the candidate map
    const candidateItems = new Map<number, TitleCandidate>();
    for (const row of matchingRows) {
        candidateItems.set(row.itemID, {
            libraryID: row.libraryID,
            key: row.key,
            normalizedTitle: row.normalizedTitle,
            doi: row.doi,
            isbn: row.isbn,
            date: row.date,
            creatorLastNames: creatorMap.get(row.itemID) || []
        });
    }

    return candidateItems;
}

/**
 * Fallback path for Phase 2: uses Zotero.Items.getAsync() + loadDataTypes().
 * Called when the fast SQL path fails (e.g., if Zotero DB schema changes).
 */
async function batchFindTitleCandidatesFallback(
    allTitleFieldIDs: number[],
    libraryIds: number[],
    normalizedInputTitles: Map<string, BatchReferenceCheckItem[]>,
    titleKeywordSets: string[][]
): Promise<Map<number, TitleCandidate>> {
    const { sql, params } = buildTitleSqlBase(
        allTitleFieldIDs, libraryIds, titleKeywordSets,
        '', '', []
    );

    logger(`batchFindTitleCandidatesFallback: Searching ${normalizedInputTitles.size} titles across ${libraryIds.length} libraries`, 1);

    const candidateItems = new Map<number, TitleCandidate>();

    // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
    const matchingRows: { itemID: number; normalizedTitle: string }[] = [];
    let totalRows = 0;

    await Zotero.DB.queryAsync(sql, params, {
        onRow: (row: any) => {
            totalRows++;
            const itemID = row.getResultByIndex(0);
            const title = row.getResultByIndex(3);
            const normalizedDbTitle = normalizeString(title);
            if (normalizedDbTitle && normalizedInputTitles.has(normalizedDbTitle)) {
                matchingRows.push({ itemID, normalizedTitle: normalizedDbTitle });
            }
        }
    });

    logger(`batchFindTitleCandidatesFallback: SQL returned ${totalRows} pre-filtered rows, found ${matchingRows.length} exact normalized matches`, 1);

    if (matchingRows.length > 0) {
        // Load all matching items in batch via Zotero API
        const itemIds = matchingRows.map(row => row.itemID);
        const zoteroItems = await Zotero.Items.getAsync(itemIds);

        if (zoteroItems.length > 0) {
            await Zotero.Items.loadDataTypes(zoteroItems, ["itemData", "creators"]);
        }

        // Build the candidate map from Zotero.Item objects
        for (let i = 0; i < matchingRows.length; i++) {
            const zoteroItem = zoteroItems[i];
            if (zoteroItem && zoteroItem.isRegularItem() && !zoteroItem.deleted) {
                const creators = zoteroItem.getCreators();
                candidateItems.set(zoteroItem.id, {
                    libraryID: zoteroItem.libraryID,
                    key: zoteroItem.key,
                    normalizedTitle: matchingRows[i].normalizedTitle,
                    doi: zoteroItem.getField('DOI') || null,
                    isbn: zoteroItem.getField('ISBN') || null,
                    date: zoteroItem.getField('date', true, true) || null,
                    creatorLastNames: creators.map((c: any) => c.lastName || '')
                });
            }
        }
    }

    return candidateItems;
}

/**
 * Phase 2: Batch title candidate collection
 * Finds all potential title matches across libraries
 *
 * Uses keyword-based LIKE pre-filtering in SQL to avoid fetching all titles.
 * Only rows whose title contains discriminating keywords from input titles
 * are returned, then normalized in JS for exact match verification.
 *
 * Tries an optimized pure-SQL path first (no getAsync/loadDataTypes), falling
 * back to the Zotero API path if the SQL approach fails.
 *
 * Runs independently of Phase 1 (no alreadyFound filter) so both phases
 * can execute in parallel.
 */
async function batchFindTitleCandidates(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<Map<number, TitleCandidate>> {
    const { needsMatching, titleFieldID, allTitleFieldIDs, normalizedInputTitles, titleKeywordSets } =
        prepareTitleSearch(items);

    if (needsMatching.length === 0 || libraryIds.length === 0 || !titleFieldID || normalizedInputTitles.size === 0) {
        return new Map();
    }

    try {
        return await batchFindTitleCandidatesFast(
            allTitleFieldIDs, libraryIds, normalizedInputTitles, titleKeywordSets
        );
    } catch (error) {
        logger(`batchFindTitleCandidates: Fast SQL path failed, falling back to API: ${error}`, 1);
        return await batchFindTitleCandidatesFallback(
            allTitleFieldIDs, libraryIds, normalizedInputTitles, titleKeywordSets
        );
    }
}

/**
 * Match a single input item against title candidates using fuzzy matching logic
 */
function findMatchInCandidates(
    inputItem: BatchReferenceCheckItem,
    candidates: Map<number, TitleCandidate>
): TitleCandidate | null {
    const normalizedInputTitle = normalizeString(inputItem.data.title);
    if (!normalizedInputTitle) {
        return null;
    }
    
    // Prepare input data
    let inputYear: number | null = null;
    if (inputItem.data.date) {
        const parsedDate = Zotero.Date.strToDate(inputItem.data.date);
        inputYear = parseYear(parsedDate.year);
    }
    const inputCreators = inputItem.data.creators || [];
    const cleanInputDOI = inputItem.data.DOI ? Zotero.Utilities.cleanDOI(inputItem.data.DOI) : null;
    const cleanInputISBN = inputItem.data.ISBN ? Zotero.Utilities.cleanISBN(String(inputItem.data.ISBN)) : null;

    for (const [, candidate] of candidates) {
        // A. Title Normalization Check (exact match required on normalized)
        if (candidate.normalizedTitle !== normalizedInputTitle) {
            continue;
        }
        
        // B. DOI Conflict Check (if both have DOIs, they must match)
        const candidateDOI = candidate.doi
            ? Zotero.Utilities.cleanDOI(candidate.doi)
            : null;
        if (cleanInputDOI && candidateDOI && cleanInputDOI !== candidateDOI) {
            continue;
        }
        
        // C. ISBN Conflict Check (if both have ISBNs, they must match)
        const candidateISBN = candidate.isbn
            ? Zotero.Utilities.cleanISBN(String(candidate.isbn))
            : null;
        if (cleanInputISBN && candidateISBN && cleanInputISBN !== candidateISBN) {
            continue;
        }
        
        // D. Year Check (Tolerance ±1 year)
        let candidateYear: number | null = null;
        if (candidate.date) {
            const parsedDate = Zotero.Date.strToDate(candidate.date);
            candidateYear = parseYear(parsedDate.year);
        }
        if (inputYear && candidateYear) {
            if (Math.abs(inputYear - candidateYear) > 1) {
                continue;
            }
        }
        
        // E. Creator Check
        const candidateCreatorLastNames = candidate.creatorLastNames;

        // Special case: if BOTH have no creators, consider it a match
        if (inputCreators.length === 0 && candidateCreatorLastNames.length === 0) {
            return candidate;
        }
        
        // If only one has creators, don't consider it a match
        if (inputCreators.length === 0 || candidateCreatorLastNames.length === 0) {
            continue;
        }
        
        // Both have creators - require at least one last name match
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
        
        if (!creatorMatch) {
            continue;
        }
        
        // All checks passed - this is a duplicate
        return candidate;
    }
    
    return null;
}

/**
 * Batch find existing references across multiple libraries.
 *
 * This is an optimized version of findExistingReference that:
 * 1. Batches all DOI lookups into a single query
 * 2. Batches all ISBN lookups into a single query
 * 3. Batches all title candidate lookups into a single query (with optional date filtering)
 * 4. Loads all candidate item data in a single batch
 * 5. Performs fuzzy matching in-memory
 *
 * @param items - Array of items to check
 * @param libraryIds - Library IDs to search in
 * @returns Object with results array and timing breakdown
 */
export async function batchFindExistingReferences(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<{ results: BatchReferenceCheckResult[]; timing: BatchReferenceCheckTiming }> {
    const startTime = Date.now();

    if (items.length === 0) {
        return {
            results: [],
            timing: {
                total_ms: 0,
                phase1_identifier_lookup_ms: 0,
                phase2_title_candidates_ms: 0,
                phase3_fuzzy_matching_ms: 0,
                candidates_fetched: 0,
                matches_by_identifier: 0,
                matches_by_fuzzy: 0,
            }
        };
    }

    if (libraryIds.length === 0) {
        return {
            results: items.map(item => ({ id: item.id, item: null })),
            timing: {
                total_ms: Date.now() - startTime,
                phase1_identifier_lookup_ms: 0,
                phase2_title_candidates_ms: 0,
                phase3_fuzzy_matching_ms: 0,
                candidates_fetched: 0,
                matches_by_identifier: 0,
                matches_by_fuzzy: 0,
            }
        };
    }

    logger(`batchFindExistingReferences: Checking ${items.length} items across ${libraryIds.length} libraries`, 1);

    // Initialize results map (lightweight references)
    const results = new Map<string, ZoteroItemReference | null>();
    for (const item of items) {
        results.set(item.id, null);
    }

    // Phase 1 & 2 run in parallel — they are independent.
    // Each wrapper captures its own elapsed time.
    let phase1Time = 0;
    let phase2Time = 0;
    const [identifierMatches, titleCandidates] = await Promise.all([
        (async () => {
            const t0 = Date.now();
            const result = await batchFindByIdentifiers(items, libraryIds);
            phase1Time = Date.now() - t0;
            return result;
        })(),
        (async () => {
            const t0 = Date.now();
            const result = await batchFindTitleCandidates(items, libraryIds);
            phase2Time = Date.now() - t0;
            return result;
        })(),
    ]);

    // Record identifier matches
    for (const [itemId, ref] of identifierMatches) {
        results.set(itemId, ref);
    }

    const foundByIdentifier = identifierMatches.size;
    logger(`batchFindExistingReferences: Found ${foundByIdentifier} items by identifier (${phase1Time}ms), ${titleCandidates.size} title candidates (${phase2Time}ms) — ran in parallel`, 1);

    // Phase 3: In-memory fuzzy matching (only for items not found by identifier)
    const phase3Start = Date.now();
    let fuzzyMatches = 0;
    for (const item of items) {
        if (results.get(item.id) !== null) {
            continue; // Already found by identifier
        }

        if (!item.data.title) {
            continue; // No title to match
        }

        const match = findMatchInCandidates(item, titleCandidates);
        if (match) {
            results.set(item.id, { library_id: match.libraryID, zotero_key: match.key });
            fuzzyMatches++;
        }
    }
    const phase3Time = Date.now() - phase3Start;

    const totalTime = Date.now() - startTime;

    logger(`batchFindExistingReferences: Completed in ${totalTime}ms. Found ${foundByIdentifier} by identifier, ${fuzzyMatches} by fuzzy match`, 1);

    // Build timing breakdown
    const timing: BatchReferenceCheckTiming = {
        total_ms: totalTime,
        phase1_identifier_lookup_ms: phase1Time,
        phase2_title_candidates_ms: phase2Time,
        phase3_fuzzy_matching_ms: phase3Time,
        candidates_fetched: titleCandidates.size,
        matches_by_identifier: foundByIdentifier,
        matches_by_fuzzy: fuzzyMatches,
    };

    // Convert to result array
    const resultArray: BatchReferenceCheckResult[] = items.map(item => ({
        id: item.id,
        item: results.get(item.id) || null
    }));

    return { results: resultArray, timing };
}
