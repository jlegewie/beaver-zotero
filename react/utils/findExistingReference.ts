/**
 * Data for finding existing references in Zotero library
 */
export interface FindReferenceData {
    /** Item title for fuzzy matching */
    title?: string;
    /** Date string (any format parseable by Zotero, e.g., 'YYYY', 'YYYY-MM-DD'). Only year is used for comparison. */
    date?: string;
    /** DOI for exact matching */
    DOI?: string;
    /** ISBN for exact matching (books) */
    ISBN?: string;
    /** Array of creator last names for fuzzy matching */
    creators?: string[];
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
 * Checks if a reference already exists in the Zotero database using Zotero's duplicate detection logic.
 * 
 * Search strategy:
 * 1. First checks for exact ISBN match (if provided)
 * 2. Then checks for exact DOI match (if provided)
 * 3. Finally performs fuzzy metadata matching using title, year (±1 tolerance), and creators
 * 
 * @param libraryID - The library to search in
 * @param data - The item data to check
 * @returns The existing item or null if no duplicate found
 */
export const findExistingReference = async (libraryID: number, data: FindReferenceData): Promise<Zotero.Item | null> => {

    // 1. Check by ISBN (Books only)
    if (data.ISBN) {
        const cleanISBN = Zotero.Utilities.cleanISBN(String(data.ISBN));
        if (cleanISBN) {
            const isbnFieldID = Zotero.ItemFields.getID('ISBN');
            if (isbnFieldID) {
                const sql = "SELECT itemID FROM items " +
                    "JOIN itemData USING (itemID) " +
                    "JOIN itemDataValues USING (valueID) " +
                    "WHERE libraryID=? AND fieldID=? AND value=? " +
                    "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
                
                const rows = await Zotero.DB.queryAsync(sql, [libraryID, isbnFieldID, cleanISBN]);
                
                if (rows && rows.length) {
                    return await Zotero.Items.getAsync(rows[0].itemID);
                }
            }
        }
    }

    // 2. Check by DOI
    if (data.DOI) {
        const cleanDOI = Zotero.Utilities.cleanDOI(data.DOI);
        if (cleanDOI) {
            const doiFieldID = Zotero.ItemFields.getID('DOI');
            if (doiFieldID) {
                const sql = "SELECT itemID FROM items " +
                    "JOIN itemData USING (itemID) " +
                    "JOIN itemDataValues USING (valueID) " +
                    "WHERE libraryID=? AND fieldID=? AND value LIKE ? " +
                    "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
                
                const rows = await Zotero.DB.queryAsync(sql, [libraryID, doiFieldID, cleanDOI]);
                
                if (rows && rows.length) {
                    return await Zotero.Items.getAsync(rows[0].itemID);
                }
            }
        }
    }

    // 3. Fuzzy Metadata Match (Title + Year + Creator)
    // This mirrors the complex logic in Zotero.Duplicates.prototype._findDuplicates
    if (!data.title) {
        return null; // No further matching possible without title
    }

    const normalizedTitle = normalizeString(data.title);
    if (!normalizedTitle) {
        return null; // Title normalizes to empty string
    }

    // Search for items with titles that contain our search title
    const search = new Zotero.Search();
    search.addCondition('libraryID', 'is', String(libraryID));
    search.addCondition('title', 'contains', data.title);
    const candidateIDs: number[] = await search.search();
    
    if (candidateIDs.length === 0) {
        return null;
    }

    const candidates: Zotero.Item[] = await Zotero.Items.getAsync(candidateIDs);
    
    // Prepare our input data for comparison
    let inputYear: number | null = null;
    if (data.date) {
        const parsedDate = Zotero.Date.strToDate(data.date);
        inputYear = parseYear(parsedDate.year);
    }
    const inputCreators = data.creators || [];
    const cleanInputDOI = data.DOI ? Zotero.Utilities.cleanDOI(data.DOI) : null;
    const cleanInputISBN = data.ISBN ? Zotero.Utilities.cleanISBN(String(data.ISBN)) : null;

    for (const candidate of candidates) {
        if (candidate.deleted) continue;
        if (!candidate.isRegularItem()) continue; // Skip notes/attachments
        
        // A. Title Normalization Check (exact match required)
        const candidateTitle = candidate.getField('title');
        if (normalizeString(candidateTitle) !== normalizedTitle) {
            continue;
        }

        // B. DOI Conflict Check (if both have DOIs, they must match)
        const candidateDOI = candidate.getField('DOI') ? Zotero.Utilities.cleanDOI(candidate.getField('DOI')) : null;
        if (cleanInputDOI && candidateDOI && cleanInputDOI !== candidateDOI) {
            continue; // Not a duplicate if DOIs differ
        }

        // C. ISBN Conflict Check (if both have ISBNs, they must match)
        const candidateISBN = candidate.getField('ISBN') ? Zotero.Utilities.cleanISBN(String(candidate.getField('ISBN'))) : null;
        if (cleanInputISBN && candidateISBN && cleanInputISBN !== candidateISBN) {
            continue; // Not a duplicate if ISBNs differ
        }

        // D. Year Check (Tolerance ±1 year)
        const candidateYear = parseYear(candidate.getField('year'));
        
        if (inputYear && candidateYear) {
            if (Math.abs(inputYear - candidateYear) > 1) {
                continue;
            }
        }

        // E. Creator Check (At least one matching last name required)
        // Special case: if BOTH have no creators, consider it a match
        const candidateCreators = candidate.getCreators();
        
        if (inputCreators.length === 0 && candidateCreators.length === 0) {
            return candidate; // Match found (both have no creators, matching title)
        }
        
        // If only one has creators, don't consider it a match
        // This is conservative but prevents false positives
        if (inputCreators.length === 0 || candidateCreators.length === 0) {
            continue; // One has creators, one doesn't - not a match
        }
        
        // Both have creators - require at least one last name match
        let creatorMatch = false;
        
        outerLoop:
        for (const inputCreatorLast of inputCreators) {
            const inputLast = normalizeString(inputCreatorLast);
            if (!inputLast) continue; // Skip empty normalized names

            for (const candidateCreator of candidateCreators) {
                const candLast = normalizeString(candidateCreator.lastName);
                if (!candLast) continue; // Skip empty normalized names

                if (inputLast === candLast) {
                    creatorMatch = true;
                    break outerLoop;
                }
            }
        }
        
        if (!creatorMatch) {
            continue; // No matching creators found
        }
        
        // All checks passed - this is a duplicate
        return candidate;
    }

    return null;
};
