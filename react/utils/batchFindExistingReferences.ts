/**
 * Batch Reference Finder
 * 
 * Optimized batch lookup for checking if multiple external references exist in Zotero.
 * Uses batch SQL queries instead of per-reference queries for much better performance.
 * 
 * Performance improvement: Reduces N×L×3 queries to approximately 5-10 queries total.
 */

import { FindReferenceData } from './findExistingReference';
import { logger } from '../../src/utils/logger';

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
    /** The found Zotero item, or null if not found */
    item: Zotero.Item | null;
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
 * Returns a map of item ID -> found Zotero item
 */
async function batchFindByIdentifiers(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<Map<string, Zotero.Item>> {
    const results = new Map<string, Zotero.Item>();
    
    if (items.length === 0 || libraryIds.length === 0) {
        return results;
    }
    
    const { doiMap, isbnMap } = cleanIdentifiers(items);
    
    // Cache field IDs
    const doiFieldID = Zotero.ItemFields.getID('DOI');
    const isbnFieldID = Zotero.ItemFields.getID('ISBN');
    
    // Build library placeholders
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');
    
    // Batch DOI lookup (case-insensitive to match original LIKE behavior)
    if (doiMap.size > 0 && doiFieldID) {
        // Normalize DOIs to lowercase for case-insensitive matching
        const doisLower = Array.from(doiMap.keys()).map(d => d.toLowerCase());
        const doiPlaceholders = doisLower.map(() => '?').join(', ');
        
        const sql = `
            SELECT itemID, value as doi 
            FROM items 
            JOIN itemData USING (itemID) 
            JOIN itemDataValues USING (valueID)
            WHERE libraryID IN (${libraryPlaceholders}) 
            AND fieldID = ? 
            AND LOWER(value) IN (${doiPlaceholders})
            AND itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        
        try {
            const params = [...libraryIds, doiFieldID, ...doisLower];
            
            // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
            const doiRows: { itemID: number; doi: string }[] = [];
            await Zotero.DB.queryAsync(sql, params, {
                onRow: (row: any) => {
                    doiRows.push({
                        itemID: row.getResultByIndex(0),
                        doi: row.getResultByIndex(1)
                    });
                }
            });
            
            logger(`batchFindByIdentifiers: DOI query returned ${doiRows.length} rows for ${doisLower.length} DOIs`, 1);
            
            if (doiRows.length > 0) {
                // Collect all item IDs to load in batch
                const itemIds = doiRows.map(row => row.itemID);
                const zoteroItems = await Zotero.Items.getAsync(itemIds);
                
                // Map DOI values to items (using lowercase for lookup)
                for (let i = 0; i < doiRows.length; i++) {
                    const row = doiRows[i];
                    const zoteroItem = zoteroItems[i];
                    if (zoteroItem) {
                        const cleanDOI = Zotero.Utilities.cleanDOI(row.doi);
                        if (cleanDOI) {
                            const requestItemIds = doiMap.get(cleanDOI.toLowerCase());
                            if (requestItemIds) {
                                for (const requestItemId of requestItemIds) {
                                    if (!results.has(requestItemId)) {
                                        results.set(requestItemId, zoteroItem);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger(`batchFindByIdentifiers: DOI batch query failed: ${error}`, 1);
        }
    }
    
    // Batch ISBN lookup (for items not already found)
    // Use LIKE pre-filtering in SQL to avoid fetching ALL ISBNs.
    // DB values may contain hyphens/spaces (e.g. "978-0-19-022485-1"), so we
    // strip them with REPLACE() before comparing against cleaned (digits-only) ISBNs.
    if (isbnMap.size > 0 && isbnFieldID) {
        // Build LIKE conditions stripping hyphens/spaces from DB values before comparison
        const isbnLikeClauses = Array.from(isbnMap.keys()).map(() => `REPLACE(REPLACE(value, '-', ''), ' ', '') LIKE ?`);
        const isbnLikeParams = Array.from(isbnMap.keys()).map(isbn => `%${isbn}%`);

        const sql = `
            SELECT itemID, value as isbn
            FROM items
            JOIN itemData USING (itemID)
            JOIN itemDataValues USING (valueID)
            WHERE libraryID IN (${libraryPlaceholders})
            AND fieldID = ?
            AND (${isbnLikeClauses.join(' OR ')})
            AND itemID NOT IN (SELECT itemID FROM deletedItems)
        `;

        try {
            const params = [...libraryIds, isbnFieldID, ...isbnLikeParams];

            // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
            // Verify each pre-filtered ISBN with cleanISBN normalization
            const matchedRows: { itemID: number; cleanISBN: string }[] = [];
            await Zotero.DB.queryAsync(sql, params, {
                onRow: (row: any) => {
                    const itemID = row.getResultByIndex(0);
                    const dbISBN = row.getResultByIndex(1);
                    const cleanISBN = Zotero.Utilities.cleanISBN(String(dbISBN));
                    // Only keep rows where the normalized ISBN matches one we're looking for
                    if (cleanISBN && isbnMap.has(cleanISBN)) {
                        matchedRows.push({ itemID, cleanISBN });
                    }
                }
            });
            
            if (matchedRows.length > 0) {
                const itemIds = matchedRows.map(row => row.itemID);
                const zoteroItems = await Zotero.Items.getAsync(itemIds);
                
                for (let i = 0; i < matchedRows.length; i++) {
                    const row = matchedRows[i];
                    const zoteroItem = zoteroItems[i];
                    if (zoteroItem) {
                        const requestItemIds = isbnMap.get(row.cleanISBN);
                        if (requestItemIds) {
                            for (const requestItemId of requestItemIds) {
                                if (!results.has(requestItemId)) {
                                    results.set(requestItemId, zoteroItem);
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger(`batchFindByIdentifiers: ISBN batch query failed: ${error}`, 1);
        }
    }
    
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
 * Phase 2: Batch title candidate collection
 * Finds all potential title matches across libraries
 *
 * Uses keyword-based LIKE pre-filtering in SQL to avoid fetching all titles.
 * Only rows whose title contains discriminating keywords from input titles
 * are returned, then normalized in JS for exact match verification.
 */
async function batchFindTitleCandidates(
    items: BatchReferenceCheckItem[],
    libraryIds: number[],
    alreadyFound: Set<string>
): Promise<Map<number, { item: Zotero.Item; normalizedTitle: string }>> {
    // Filter to items that still need matching and have titles
    const needsMatching = items.filter(item =>
        !alreadyFound.has(item.id) && item.data.title
    );

    if (needsMatching.length === 0 || libraryIds.length === 0) {
        return new Map();
    }

    // Get all title field IDs (base + mapped fields like caseName, subject, nameOfAct)
    // Zotero item types like case, email, statute store titles in mapped fields.
    // See Zotero's duplicates.js for the same pattern.
    const titleFieldID = Zotero.ItemFields.getID('title');
    if (!titleFieldID) {
        return new Map();
    }
    const mappedTitleFieldIDs = Zotero.ItemFields.getTypeFieldsFromBase('title');
    const allTitleFieldIDs = [titleFieldID, ...(mappedTitleFieldIDs || [])];

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

    if (normalizedInputTitles.size === 0) {
        return new Map();
    }

    // Extract keywords from each title for SQL pre-filtering.
    // For each title, we require ALL keywords to match (AND), then OR across titles.
    // extractFilterKeywords prefers ASCII-only words which avoids diacritics
    // mismatches (e.g. "etudes" vs "études") without needing dual variants.
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

    // Build SQL with keyword LIKE pre-filtering
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');
    const titlePlaceholders = allTitleFieldIDs.map(() => '?').join(', ');

    let sql = `
        SELECT DISTINCT i.itemID, title_val.value as title
        FROM items i
        JOIN itemData title_data ON i.itemID = title_data.itemID AND title_data.fieldID IN (${titlePlaceholders})
        JOIN itemDataValues title_val ON title_data.valueID = title_val.valueID
        WHERE i.libraryID IN (${libraryPlaceholders})
        AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
    `;

    const params: (string | number)[] = [...allTitleFieldIDs, ...libraryIds];

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

    logger(`batchFindTitleCandidates: Searching ${normalizedInputTitles.size} titles with ${titleKeywordSets.length} keyword sets across ${libraryIds.length} libraries`, 1);

    const candidateItems = new Map<number, { item: Zotero.Item; normalizedTitle: string }>();

    try {
        // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
        // The LIKE filter narrows candidates; normalizeString verifies exact match
        const matchingRows: { itemID: number; title: string; normalizedTitle: string }[] = [];
        let totalRows = 0;

        await Zotero.DB.queryAsync(sql, params, {
            onRow: (row: any) => {
                totalRows++;
                const itemID = row.getResultByIndex(0);
                const title = row.getResultByIndex(1);
                const normalizedDbTitle = normalizeString(title);
                if (normalizedDbTitle && normalizedInputTitles.has(normalizedDbTitle)) {
                    matchingRows.push({ itemID, title, normalizedTitle: normalizedDbTitle });
                }
            }
        });

        logger(`batchFindTitleCandidates: SQL returned ${totalRows} pre-filtered rows, found ${matchingRows.length} exact normalized matches`, 1);

        if (matchingRows.length > 0) {
            // Load all matching items in batch
            const itemIds = matchingRows.map(row => row.itemID);
            const zoteroItems = await Zotero.Items.getAsync(itemIds);

            // Single batch load of all item data
            if (zoteroItems.length > 0) {
                await Zotero.Items.loadDataTypes(zoteroItems, ["itemData", "creators", "childItems"]);
            }

            // Build the candidate map
            for (let i = 0; i < matchingRows.length; i++) {
                const zoteroItem = zoteroItems[i];
                if (zoteroItem && zoteroItem.isRegularItem() && !zoteroItem.deleted) {
                    candidateItems.set(zoteroItem.id, {
                        item: zoteroItem,
                        normalizedTitle: matchingRows[i].normalizedTitle
                    });
                }
            }
        }
    } catch (error) {
        logger(`batchFindTitleCandidates: Title batch query failed: ${error}`, 1);
    }

    return candidateItems;
}

/**
 * Match a single input item against title candidates using fuzzy matching logic
 */
function findMatchInCandidates(
    inputItem: BatchReferenceCheckItem,
    candidates: Map<number, { item: Zotero.Item; normalizedTitle: string }>
): Zotero.Item | null {
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
    
    for (const [, { item: candidate, normalizedTitle }] of candidates) {
        // A. Title Normalization Check (exact match required on normalized)
        if (normalizedTitle !== normalizedInputTitle) {
            continue;
        }
        
        // B. DOI Conflict Check (if both have DOIs, they must match)
        const candidateDOI = candidate.getField('DOI') 
            ? Zotero.Utilities.cleanDOI(candidate.getField('DOI')) 
            : null;
        if (cleanInputDOI && candidateDOI && cleanInputDOI !== candidateDOI) {
            continue;
        }
        
        // C. ISBN Conflict Check (if both have ISBNs, they must match)
        const candidateISBN = candidate.getField('ISBN') 
            ? Zotero.Utilities.cleanISBN(String(candidate.getField('ISBN'))) 
            : null;
        if (cleanInputISBN && candidateISBN && cleanInputISBN !== candidateISBN) {
            continue;
        }
        
        // D. Year Check (Tolerance ±1 year)
        const candidateYear = parseYear(candidate.getField('year'));
        if (inputYear && candidateYear) {
            if (Math.abs(inputYear - candidateYear) > 1) {
                continue;
            }
        }
        
        // E. Creator Check
        const candidateCreators = candidate.getCreators();
        
        // Special case: if BOTH have no creators, consider it a match
        if (inputCreators.length === 0 && candidateCreators.length === 0) {
            return candidate;
        }
        
        // If only one has creators, don't consider it a match
        if (inputCreators.length === 0 || candidateCreators.length === 0) {
            continue;
        }
        
        // Both have creators - require at least one last name match
        let creatorMatch = false;
        
        outerLoop:
        for (const inputCreatorLast of inputCreators) {
            const inputLast = normalizeString(inputCreatorLast);
            if (!inputLast) continue;
            
            for (const candidateCreator of candidateCreators) {
                const candLast = normalizeString(candidateCreator.lastName);
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

    // Initialize results map
    const results = new Map<string, Zotero.Item | null>();
    for (const item of items) {
        results.set(item.id, null);
    }

    // Phase 1: Batch identifier matching (DOI and ISBN)
    const phase1Start = Date.now();
    const identifierMatches = await batchFindByIdentifiers(items, libraryIds);
    const phase1Time = Date.now() - phase1Start;

    // Record found items
    for (const [itemId, zoteroItem] of identifierMatches) {
        results.set(itemId, zoteroItem);
    }

    const foundByIdentifier = identifierMatches.size;
    logger(`batchFindExistingReferences: Found ${foundByIdentifier} items by identifier in ${phase1Time}ms`, 1);

    // Phase 2: Batch title candidate collection and data loading
    const phase2Start = Date.now();
    const alreadyFound = new Set(identifierMatches.keys());
    const titleCandidates = await batchFindTitleCandidates(items, libraryIds, alreadyFound);
    const phase2Time = Date.now() - phase2Start;

    logger(`batchFindExistingReferences: Found ${titleCandidates.size} title candidates in ${phase2Time}ms`, 1);

    // Phase 3: In-memory fuzzy matching
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
            results.set(item.id, match);
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
    const resultArray = items.map(item => ({
        id: item.id,
        item: results.get(item.id) || null
    }));

    return { results: resultArray, timing };
}
