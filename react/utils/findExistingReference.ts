
export interface FindReferenceData {
    title?: string;
    date?: string;
    DOI?: string;
    ISBN?: string;
    creators?: string[];
}

function normalizeString(str: string | undefined | null): string {
    const s = str ? str + "" : "";
    if (s === "") return "";
    
    return Zotero.Utilities.removeDiacritics(s)
        .replace(/[ !-/:-@[-`{-~]+/g, ' ') // Convert (ASCII) punctuation to spaces
        .trim()
        .toLowerCase();
}

/**
 * Checks if a reference already exists in the Zotero database using Zotero's duplicate detection logic.
 * 
 * @param libraryID - The library to search in
 * @param data - The item data to check
 * @returns The existing item or null
 */
export const findExistingReference = async (libraryID: number, data: FindReferenceData): Promise<Zotero.Item | null> => {

    // 1. Check by ISBN (Books only)
    if (data.ISBN) {
        const cleanISBN = Zotero.Utilities.cleanISBN(String(data.ISBN));
        if (cleanISBN) {
            const sql = "SELECT itemID FROM items " +
                "JOIN itemData USING (itemID) " +
                "JOIN itemDataValues USING (valueID) " +
                "WHERE libraryID=? AND fieldID=? AND value=? " +
                "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
            
            const isbnFieldID = Zotero.ItemFields.getID('ISBN');
            const rows = await Zotero.DB.queryAsync(sql, [libraryID, isbnFieldID, cleanISBN]);
            
            if (rows && rows.length) {
                return await Zotero.Items.getAsync(rows[0].itemID);
            }
        }
    }

    // 2. Check by DOI
    if (data.DOI) {
        const cleanDOI = Zotero.Utilities.cleanDOI(data.DOI);
        if (cleanDOI) {
            // DOI search should be case-insensitive ('10.%')
            // We use LIKE for case-insensitivity in SQLite if not configured otherwise, 
            // but it's safer to just check if we get a hit.
            const sql = "SELECT itemID FROM items " +
                "JOIN itemData USING (itemID) " +
                "JOIN itemDataValues USING (valueID) " +
                "WHERE libraryID=? AND fieldID=? AND value LIKE ? " +
                "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
            
            const doiFieldID = Zotero.ItemFields.getID('DOI');
            const rows = await Zotero.DB.queryAsync(sql, [libraryID, doiFieldID, cleanDOI]);
            
            if (rows && rows.length) {
                return await Zotero.Items.getAsync(rows[0].itemID);
            }
        }
    }

    // 3. Fuzzy Metadata Match (Title + Year + Creator)
    // This mirrors the complex logic in Zotero.Duplicates.prototype._findDuplicates
    if (data.title) {
        const normalizedTitle = normalizeString(data.title);
        if (!normalizedTitle) return null;

        // Search for items with matching normalized title
        // We fetch potential candidates first
        
        // Note: This query fetches candidates. We filter them below.
        // Optimizing by searching for the exact normalized string might be hard purely in SQL 
        // because of the JS-specific normalization. 
        // Instead, we can use Zotero.Search for a rough title match or exact match to narrow down.
        // Given exact duplicate detection logic usually expects "very close" titles,
        // let's try to find items that *contain* the title or use the Search API for "is" if possible,
        // but the most robust way following duplicates.js is to get items that match the title roughly.
        
        // However, loading ALL items to check normalization is expensive. 
        // A good heuristic: Search for items where title is "like" our title.
        
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', libraryID);
        search.addCondition('title', 'contains', data.title);
        const candidateIDs: number[] = await search.search();
        
        if (candidateIDs.length === 0) {
            // Fallback: 'contains' might be too broad, but 'is' might miss slight punctuation diffs handled by normalizeString.
            // Let's stick to 'is' for performance, or maybe 'contains' if the title is long enough.
            return null; 
        }

        const candidates: any[] = await Zotero.Items.getAsync(candidateIDs);
        
        // Prepare our input data for comparison
        let inputYear: number | null = null;
        if (data.date) {
            const parsedDate = Zotero.Date.strToDate(data.date);
            if (parsedDate.year) inputYear = parseInt(parsedDate.year);
        }
        const inputCreators = data.creators || [];
        const cleanInputDOI = data.DOI ? Zotero.Utilities.cleanDOI(data.DOI) : null;
        const cleanInputISBN = data.ISBN ? Zotero.Utilities.cleanISBN(String(data.ISBN)) : null;

        for (const candidate of candidates) {
            if (candidate.deleted) continue;
            if (!candidate.isRegularItem()) continue; // Skip notes/attachments
            
            // A. Title Normalization Check
            const candidateTitle = candidate.getField('title');
            if (normalizeString(candidateTitle) !== normalizedTitle) {
                continue;
            }

            // B. DOI Conflict Check
            let candidateDOI = candidate.getField('DOI');
            if (candidateDOI) candidateDOI = Zotero.Utilities.cleanDOI(candidateDOI);
            if (cleanInputDOI && candidateDOI && cleanInputDOI !== candidateDOI) {
                continue; // Not a duplicate if DOIs differ
            }

            // C. ISBN Conflict Check
            let candidateISBN = candidate.getField('ISBN');
            if (candidateISBN) candidateISBN = Zotero.Utilities.cleanISBN(String(candidateISBN));
            if (cleanInputISBN && candidateISBN && cleanInputISBN !== candidateISBN) {
                continue; // Not a duplicate if ISBNs differ
            }

            // D. Year Check (Tolerance +/- 1 year)
            let candidateYear = candidate.getField('year'); 
            if (candidateYear) candidateYear = parseInt(candidateYear);
            
            if (inputYear && candidateYear) {
                if (Math.abs(inputYear - candidateYear) > 1) {
                    continue;
                }
            }

            // E. Creator Check (At least one match on LastName)
            // If either has no creators, we assume match (following duplicates.js logic: "Match if no creators")
            const candidateCreators = candidate.getCreators();
            
            if (inputCreators.length === 0 && candidateCreators.length === 0) {
                return candidate; // Match found (empty creators, matching title)
            }
            
            if (inputCreators.length > 0 && candidateCreators.length > 0) {
                let creatorMatch = false;
                
                outerLoop:
                for (const inputCreatorLast of inputCreators) {
                    const inputLast = normalizeString(inputCreatorLast);

                    for (const candidateCreator of candidateCreators) {
                        const candLast = normalizeString(candidateCreator.lastName);

                        if (inputLast === candLast) {
                            creatorMatch = true;
                            break outerLoop;
                        }
                    }
                }
                
                if (!creatorMatch) continue;
            }
            
            // If we passed all checks
            return candidate;
        }
    }

    return null;
};
