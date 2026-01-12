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
    if (isbnMap.size > 0 && isbnFieldID) {
        const isbns = Array.from(isbnMap.keys());
        const isbnPlaceholders = isbns.map(() => '?').join(', ');
        
        const sql = `
            SELECT itemID, value as isbn 
            FROM items 
            JOIN itemData USING (itemID) 
            JOIN itemDataValues USING (valueID)
            WHERE libraryID IN (${libraryPlaceholders}) 
            AND fieldID = ? 
            AND value IN (${isbnPlaceholders})
            AND itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        
        try {
            const params = [...libraryIds, isbnFieldID, ...isbns];
            
            // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
            const isbnRows: { itemID: number; isbn: string }[] = [];
            await Zotero.DB.queryAsync(sql, params, {
                onRow: (row: any) => {
                    isbnRows.push({
                        itemID: row.getResultByIndex(0),
                        isbn: row.getResultByIndex(1)
                    });
                }
            });
            
            if (isbnRows.length > 0) {
                const itemIds = isbnRows.map(row => row.itemID);
                const zoteroItems = await Zotero.Items.getAsync(itemIds);
                
                for (let i = 0; i < isbnRows.length; i++) {
                    const row = isbnRows[i];
                    const zoteroItem = zoteroItems[i];
                    if (zoteroItem) {
                        const cleanISBN = Zotero.Utilities.cleanISBN(String(row.isbn));
                        if (cleanISBN) {
                            const requestItemIds = isbnMap.get(cleanISBN);
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
            logger(`batchFindByIdentifiers: ISBN batch query failed: ${error}`, 1);
        }
    }
    
    return results;
}

/**
 * Phase 2: Batch title candidate collection
 * Finds all potential title matches across libraries
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
    
    // Get title field ID
    const titleFieldID = Zotero.ItemFields.getID('title');
    if (!titleFieldID) {
        return new Map();
    }
    
    // Build LIKE conditions for each title
    // Use normalized titles for matching
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
    
    // Log sample of what we're looking for
    const sampleTitles = Array.from(normalizedInputTitles.keys()).slice(0, 3);
    logger(`batchFindTitleCandidates: Looking for normalized titles like: ${JSON.stringify(sampleTitles)}`, 1);
    
    // Build library placeholders
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');
    
    // For SQL LIKE matching, we'll use a broader search and filter in-memory
    // This is more efficient than many OR conditions
    const sql = `
        SELECT DISTINCT itemID, value as title
        FROM items 
        JOIN itemData USING (itemID) 
        JOIN itemDataValues USING (valueID)
        WHERE libraryID IN (${libraryPlaceholders}) 
        AND fieldID = ?
        AND itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    
    const candidateItems = new Map<number, { item: Zotero.Item; normalizedTitle: string }>();
    
    try {
        const params = [...libraryIds, titleFieldID];
        
        // Use onRow callback to avoid Proxy issues with Zotero.DB.queryAsync
        // Filter candidates by normalized title match during iteration
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
        
        logger(`batchFindTitleCandidates: SQL returned ${totalRows} rows, found ${matchingRows.length} matching normalized titles`, 1);
        
        if (matchingRows.length > 0) {
            // Load all matching items in batch
            const itemIds = matchingRows.map(row => row.itemID);
            const zoteroItems = await Zotero.Items.getAsync(itemIds);
            
            // Phase 3: Single batch load of all item data
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
 * 3. Batches all title candidate lookups into a single query
 * 4. Loads all candidate item data in a single batch
 * 5. Performs fuzzy matching in-memory
 * 
 * @param items - Array of items to check
 * @param libraryIds - Library IDs to search in
 * @returns Array of results with found items
 */
export async function batchFindExistingReferences(
    items: BatchReferenceCheckItem[],
    libraryIds: number[]
): Promise<BatchReferenceCheckResult[]> {
    if (items.length === 0) {
        return [];
    }
    
    if (libraryIds.length === 0) {
        return items.map(item => ({ id: item.id, item: null }));
    }
    
    logger(`batchFindExistingReferences: Checking ${items.length} items across ${libraryIds.length} libraries`, 1);
    const startTime = Date.now();
    
    
    // Initialize results map
    const results = new Map<string, Zotero.Item | null>();
    for (const item of items) {
        results.set(item.id, null);
    }
    
    // Phase 1: Batch identifier matching (DOI and ISBN)
    const identifierMatches = await batchFindByIdentifiers(items, libraryIds);
    
    // Record found items
    for (const [itemId, zoteroItem] of identifierMatches) {
        results.set(itemId, zoteroItem);
    }
    
    const foundByIdentifier = identifierMatches.size;
    logger(`batchFindExistingReferences: Found ${foundByIdentifier} items by identifier`, 1);
    
    // Phase 2 & 3: Batch title candidate collection and data loading
    const alreadyFound = new Set(identifierMatches.keys());
    const titleCandidates = await batchFindTitleCandidates(items, libraryIds, alreadyFound);
    
    logger(`batchFindExistingReferences: Found ${titleCandidates.size} title candidates for fuzzy matching`, 1);
    
    // Phase 4: In-memory fuzzy matching
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
    
    const elapsed = Date.now() - startTime;
    logger(`batchFindExistingReferences: Completed in ${elapsed}ms. Found ${foundByIdentifier} by identifier, ${fuzzyMatches} by fuzzy match`, 1);
    
    // Convert to result array
    return items.map(item => ({
        id: item.id,
        item: results.get(item.id) || null
    }));
}
