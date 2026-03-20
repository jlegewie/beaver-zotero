import { truncateText } from './stringUtils';
import { stripHtmlTags, computeDiff } from '../components/agentRuns/EditNotePreview';
import { logger } from '../../src/utils/logger';
import { syncingItemFilter, syncingItemFilterAsync, isSupportedItem, isLibraryValidForSync } from '../../src/utils/sync';
import { isValidAnnotationType, SourceAttachment } from '../types/attachments/apiTypes';
import { selectItemById } from '../../src/utils/selectItem';
import { CitationData } from '../types/citations';
import { ZoteroItemReference } from '../types/zotero';
import { isDatabaseSyncSupportedAtom, searchableLibraryIdsAtom, syncWithZoteroAtom} from '../atoms/profile';
import { store } from '../store';
import { userIdAtom } from '../atoms/auth';
import { isAttachmentOnServer } from '../../src/utils/webAPI';
import { safeFileExists } from '../../src/utils/zoteroUtils';

// Constants
export const MAX_NOTE_TITLE_LENGTH = 20;
export const MAX_NOTE_CONTENT_LENGTH = 150;

// Limits
export const FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB
export const MAX_ATTACHMENTS = 10;
export const MAX_PAGES = 100;

export const VALID_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'] as const;
type ValidMimeType = typeof VALID_MIME_TYPES[number];

function isValidMimeType(mimeType: string): mimeType is ValidMimeType {
    return VALID_MIME_TYPES.includes(mimeType as ValidMimeType);
}

export function getDisplayNameFromItem(item: Zotero.Item, count: number | null = null): string {
    let displayName: string;
    
    if (item.isNote()) {
        displayName = truncateText(item.getNoteTitle(), MAX_NOTE_TITLE_LENGTH);
    } else if(item.isAttachment() && !item.parentItem) {
        displayName = item.getField('title') || '';
    } else {
        const firstCreator = item.firstCreator || item.getField('title') || 'Unknown Author';
        const year = item.getField('date')?.match(/\d{4}/)?.[0] || '';
        displayName = `${firstCreator}${year ? ` ${year}` : ''}`;
    }
    
    if (count && count > 1) displayName = `${displayName} (${count})`;
    return displayName;
}

export function getReferenceFromItem(item: Zotero.Item): string {
    const formatted_citation = item.isNote()
        // @ts-ignore unescapeHTML exists
        ? truncateText(Zotero.Utilities.unescapeHTML(item.getNote()), MAX_NOTE_CONTENT_LENGTH)
        : Zotero.Beaver?.citationService?.formatBibliography(item) ?? '';
    return formatted_citation.replace(/\n/g, '<br />');
}


/**
* Source method: Get the Zotero item from a Source
*/
export function getZoteroItem(source: SourceAttachment | CitationData): Zotero.Item | null {
    try {
        let libId: number;
        let itemKeyValue: string;
        if (!source.library_id || !source.zotero_key) return null;

        if ('library_id' in source && 'zotero_key' in source) {
            libId = source.library_id;
            itemKeyValue = source.zotero_key;
        } else {
            console.error("getZoteroItem: Source object does not have expected key structure (libraryID/itemKey or library_id/zotero_key):", source);
            return null;
        }
        const item = Zotero.Items.getByLibraryAndKey(libId, itemKeyValue);
        return item || null;
    } catch (error) {
        console.error("Error retrieving Zotero item:", error);
        return null;
    }
}

/**
 * Check if an item was added before the last sync
 * @param item The item to check
 * @param syncWithZotero Whether to use Zotero sync
 * @param userID The user ID
 * @returns True if the item was added before the last sync
 */
export async function wasItemAddedBeforeLastSync(item: Zotero.Item, syncWithZotero: boolean, userID: string): Promise<boolean> {
    let syncLog = null;
    if (syncWithZotero) {
        syncLog = await Zotero.Beaver.db.getSyncLogWithHighestVersion(userID, item.libraryID);
    } else {
        syncLog = await Zotero.Beaver.db.getSyncLogWithMostRecentDate(userID, item.libraryID);
    }

    if (!syncLog) {
        return false;
    }

    const lastSyncDate = syncLog.library_date_modified;
    const itemDateAdded = item.dateAdded;
    const lastSyncDateSQL = Zotero.Date.isISODate(lastSyncDate) 
        ? Zotero.Date.isoToSQL(lastSyncDate) 
        : lastSyncDate;
    
    // Item was added before the last sync
    return itemDateAdded <= lastSyncDateSQL;
}

/**
* Source method: Check if a source is valid
*/
export async function isValidZoteroItem(item: Zotero.Item): Promise<{valid: boolean, error?: string}> {

    // User ID
    const userID = store.get(userIdAtom);
    if (!userID) return {valid: false, error: "User ID not found. Make sure you are logged in."};

    // Is database sync supported?
    const isDatabaseSyncSupported = store.get(isDatabaseSyncSupportedAtom);

    // Item library
    const library = Zotero.Libraries.get(item.libraryID);
    if (!library) {
        return {valid: false, error: "Library not found"};
    }

    // Is library searchable?
    const libraryIds = store.get(searchableLibraryIdsAtom);
    if (!libraryIds.includes(item.libraryID)) {
        const library_name = library ? library.name : undefined;
        return {
            valid: false,
            error: library_name
                ? `The library "${library_name}" is not synced with Beaver.`
                : "This library is not synced with Beaver."};
    }

    // Is the library valid for sync?
    const syncWithZotero = store.get(syncWithZoteroAtom);
    if (isDatabaseSyncSupported && library.isGroup && !syncWithZotero) {
        return {valid: false, error: `The group library "${library.name}" cannot be synced with Beaver because the setting "Coordinate with Zotero Sync" is disabled.`};
    }

    if (isDatabaseSyncSupported && !isLibraryValidForSync(library, syncWithZotero)) {
        return {valid: false, error: `The group library "${library.name}" cannot be synced with Beaver. Please check Beaver Preferences to resolve this issue.`};
    }

    // ------- Regular items -------
    if (item.isRegularItem()) {
        if (item.isInTrash()) return {valid: false, error: "Item is in trash"};

        // (a) Pass the syncing filter
        if (!(await syncingItemFilterAsync(item))) {
            return {valid: false, error: "File not available to use in Beaver"};
        }

        // (b) If syncWithZotero is true, check whether item has been synced with Zotero
        if (isDatabaseSyncSupported && syncWithZotero && item.version === 0 && !item.synced) {
            return {valid: false, error: "Item not yet synced with Zotero and therefore not available in Beaver."};
        }
        
        // (c) Check whether item was added after the last sync
        if (isDatabaseSyncSupported && !(await wasItemAddedBeforeLastSync(item, syncWithZotero, userID))) {
            return {valid: false, error: "Item not yet synced with Beaver. Please wait for sync to complete or sync manually in settings."};
        }

        return {valid: true};
    }

    // ------- Attachments -------
    else if (item.isAttachment()) {

        // (a) Check if attachment is supported
        if (!isSupportedItem(item)) {
            return {valid: false, error: "Beaver only supports PDF attachments"};
        }

        // (b) Check if attachment is in trash
        if (item.isInTrash()) return {valid: false, error: "Item is in trash"};

        
        // (c) Check if file exists locally or on server
        if (!(await safeFileExists(item)) && !isAttachmentOnServer(item)) {
            return {valid: false, error: "File unavailable locally and on server"};
        }

        // (d) Use comprehensive syncing filter
        if (!(await syncingItemFilterAsync(item))) {
            return {valid: false, error: "Attachment not synced with Beaver"};
        }
        
        // (e) If syncWithZotero is true, check whether item has been synced with Zotero
        if (isDatabaseSyncSupported && syncWithZotero && item.version === 0 && !item.synced) {
            return {valid: false, error: "Attachment not yet synced with Zotero and therefore not available in Beaver."};
        }

        // (f) Check whether attachment was added after the last sync
        if (isDatabaseSyncSupported && !(await wasItemAddedBeforeLastSync(item, syncWithZotero, userID))) {
            return {valid: false, error: "Attachment not yet synced with Beaver. Please wait for sync to complete or sync manually in settings."};
        }

        // Confirm upload status
        // const userId = store.get(userIdAtom) || '';
        // const attachment = await Zotero.Beaver.db.getAttachmentByZoteroKey(userId, item.libraryID, item.key);
        // if (!attachment) return {valid: false, error: "Attachment not found"};
        // if (attachment.upload_status !== 'completed') return {valid: false, error: "Attachment not uploaded"};

        return {valid: true};
    }

    // ------- Annotations -------
    else if (item.isAnnotation()) {
        // (a) Check if the annotation type is valid
        if (!isValidAnnotationType(item.annotationType)) return {valid: false, error: "Invalid annotation type"};

        // (b) Check if annotation is empty
        if (item.annotationType === 'underline' && !item.annotationText && !item.annotationComment) return {valid: false, error: "Annotation is empty"};
        if (item.annotationType === 'highlight' && !item.annotationText && !item.annotationComment) return {valid: false, error: "Annotation is empty"};
        // if (item.annotationType === 'note' && !item.annotationText && !item.annotationComment) return {valid: false, error: "Annotation is empty"};

        // (c) Check if the parent exists and is an attachment
        const parent = item.parentItem;
        if (!parent || !parent.isAttachment()) return {valid: false, error: "Parent item is not an attachment"};

        // (d) Check if the parent exists and is syncing
        if (!syncingItemFilter(parent)) return {valid: false, error: "Parent item is not syncing"};

        // (e) Check if the parent file exists
        const hasFile = await safeFileExists(parent);
        if (!hasFile) return {valid: false, error: "Parent file does not exist"};

        // (f) If syncWithZotero is true, check whether item has been synced with Zotero
        if (isDatabaseSyncSupported && syncWithZotero && parent.version === 0 && !parent.synced) {
            return {valid: false, error: "Attachment not yet synced with Zotero and therefore not available in Beaver."};
        }

        // (g) Check whether attachment was added after the last sync
        if (isDatabaseSyncSupported && !(await wasItemAddedBeforeLastSync(parent, syncWithZotero, userID))) {
            return {valid: false, error: "Attachment not yet synced with Beaver. Please wait for sync to complete or sync manually in settings."};
        }

        return {valid: true};
    }

    // ------- Notes -------
    else if (item.isNote()) {
        if (item.isInTrash()) return {valid: false, error: "Note is in trash"};
        return {valid: true};
    }

    return {valid: false, error: "Invalid item type"};
}

/**
 * Reveal source item in Zotero, optionally in a specific collection
 * @param source - The source item to reveal
 * @param collectionKey - Optional collection key to navigate to before revealing
 */
export function revealSource(source: ZoteroItemReference | SourceAttachment | CitationData, collectionKey?: string) {
    if (!source.library_id || !source.zotero_key) return;
    const itemID = Zotero.Items.getIDFromLibraryAndKey(source.library_id, source.zotero_key);
    if (itemID && Zotero.getActiveZoteroPane()) {
        // Convert collection key to collection ID if provided
        let collectionId: number | undefined;
        if (collectionKey) {
            const id = Zotero.Collections.getIDFromLibraryAndKey(source.library_id, collectionKey);
            if (id !== false) {
                collectionId = id;
            }
        }
        selectItemById(itemID, true, collectionId);
    }
}

export async function openSource(source: SourceAttachment | CitationData) {
    const item = getZoteroItem(source);
    if (!item) return;
    
    // Regular items
    if (item.isRegularItem()) {
        const bestAttachment = await item.getBestAttachment();
        if (bestAttachment) {
            Zotero.getActiveZoteroPane().viewAttachment(bestAttachment.id);
        }
    }

    // Attachments
    if (item.isAttachment()) {
        Zotero.getActiveZoteroPane().viewAttachment(item.id);
    }

    // Notes
    if (item.isNote()) {
        await openNoteById(item.id);
    }
}

/**
 * Open a note in the Zotero editor (tab or window based on user preference).
 * Uses Zotero.Notes.open() which respects the `extensions.zotero.openNoteInNewWindow` setting.
 */
export async function openNoteById(itemId: number): Promise<void> {
    try {
        await (Zotero as any).Notes.open(itemId);
    } catch {
        // Fallback for older Zotero versions without Notes.open
        Zotero.getActiveZoteroPane()?.openNoteWindow?.(itemId);
    }
}

/**
 * Open a note by library ID and zotero key.
 */
export async function openNoteByKey(libraryId: number, zoteroKey: string): Promise<void> {
    const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
    if (itemId) {
        await openNoteById(itemId);
    }
}

/**
 * Open a note and search for the edited text, scrolling to the match.
 * Uses the ProseMirror search plugin to highlight and scroll to the relevant
 * section of the note.
 *
 * @param libraryId - Library ID of the note item
 * @param zoteroKey - Zotero key of the note item
 * @param oldString - The original string being replaced (simplified HTML)
 * @param newString - The replacement string (simplified HTML)
 * @param isApplied - Whether the edit has already been applied
 */
export async function openNoteAndSearchEdit(
    libraryId: number,
    zoteroKey: string,
    oldString: string,
    newString: string,
    isApplied: boolean,
): Promise<void> {
    logger(`openNoteAndSearchEdit: called with libraryId=${libraryId}, zoteroKey=${zoteroKey}, isApplied=${isApplied}`, 1);
    logger(`openNoteAndSearchEdit: oldString (${oldString.length} chars): "${oldString.substring(0, 200)}"`, 1);
    logger(`openNoteAndSearchEdit: newString (${newString.length} chars): "${newString.substring(0, 200)}"`, 1);

    const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
    if (!itemId) {
        logger(`openNoteAndSearchEdit: item not found for ${libraryId}-${zoteroKey}, aborting`, 1);
        return;
    }
    logger(`openNoteAndSearchEdit: resolved itemId=${itemId}`, 1);

    // Check if the note is already open in an editor before opening.
    // If not, we'll need to wait longer for the tab to fully initialize.
    const wasAlreadyOpen = (Zotero as any).Notes?._editorInstances?.some(
        (e: any) => e.itemID === itemId
    ) ?? false;
    logger(`openNoteAndSearchEdit: note wasAlreadyOpen=${wasAlreadyOpen}`, 1);

    // Open the note (or focus if already open)
    await openNoteById(itemId);
    logger(`openNoteAndSearchEdit: note opened/focused`, 1);

    // When opening a note in a new tab, the tab switch triggers async UI
    // events (useZoteroTabSelection, useZoteroContext) that can reinitialize
    // the editor after our search runs. Wait for the tab switch to settle.
    if (!wasAlreadyOpen) {
        logger(`openNoteAndSearchEdit: waiting 500ms for new tab to settle`, 1);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Determine what to search for and what to select based on edit status.
    let searchText: string | null = null;
    let selectText: string | undefined;
    let endSearchText: string | undefined;

    if (isApplied) {
        // For applied edits, prefer the highlighted diff (diff-char-add text).
        // extractHighlightedAddition returns a wider searchText (for
        // disambiguation), a narrow selectText (the actual highlight), and
        // optionally endSearchText (last addition line for multi-line edits).
        const result = extractHighlightedAddition(oldString, newString);
        if (result) {
            searchText = result.searchText;
            selectText = result.selectText;
            endSearchText = result.endSearchText;
            logger(`openNoteAndSearchEdit: extractHighlightedAddition: searchText="${searchText.substring(0, 80)}", selectText="${selectText.substring(0, 80)}"${endSearchText ? `, endSearchText="${endSearchText.substring(0, 80)}"` : ''}`, 1);
        } else {
            // Fall back to first line of newString (e.g. pure insertions
            // where the entire line is new and there's no char-level diff).
            searchText = extractSearchTerm(newString);
            logger(`openNoteAndSearchEdit: fell back to extractSearchTerm(newString): ${searchText ? `"${searchText}"` : 'null'}`, 1);
        }
    } else {
        // For non-applied edits, search for the old text that will be replaced.
        searchText = extractSearchTerm(oldString);
        logger(`openNoteAndSearchEdit: extractSearchTerm(oldString): ${searchText ? `"${searchText}"` : 'null'}`, 1);
    }

    if (!searchText) {
        logger(`openNoteAndSearchEdit: no search text resolved, aborting search`, 1);
        return;
    }
    logger(`openNoteAndSearchEdit: final searchText="${searchText}", selectText=${selectText ? `"${selectText}"` : 'undefined'}, endSearchText=${endSearchText ? `"${endSearchText}"` : 'undefined'}`, 1);

    // Wait for the editor instance to be available and initialized,
    // then select the text and scroll to it.
    const found = await selectAndScrollInNoteEditor(itemId, searchText, selectText, endSearchText);

    // Fallback: if the primary search failed (e.g. applied edit but the
    // editor DOM still has the old content — undo, manual revert, race
    // condition), try the opposite text.
    if (!found) {
        const fallbackText = isApplied
            ? extractSearchTerm(oldString)
            : extractSearchTerm(newString);
        if (fallbackText) {
            logger(`openNoteAndSearchEdit: primary search failed, trying fallback: "${fallbackText}"`, 1);
            await selectAndScrollInNoteEditor(itemId, fallbackText);
        }
    }
}

/**
 * Extract search and selection text from the diff between old and new HTML.
 *
 * Returns:
 *  - `searchText`: the first addition line (used for locating the edit and
 *    for disambiguation when `selectText` is not unique).
 *  - `selectText`: the highlighted (diff-char-add) portion of the first
 *    addition line — the narrowest text we want to select.
 *  - `endSearchText` (optional): the last addition line text, returned only
 *    for multi-line edits so the selection can span the full edit range.
 *
 * Returns null when no addition with a highlight is found or the result is
 * too short to be a useful search term.
 */
function extractHighlightedAddition(
    oldHtml: string,
    newHtml: string,
): { searchText: string; selectText: string; endSearchText?: string } | null {
    const strippedOld = stripHtmlTags(oldHtml);
    const strippedNew = stripHtmlTags(newHtml);
    logger(`extractHighlightedAddition: strippedOld (${strippedOld.length} chars): "${strippedOld.substring(0, 150)}"`, 1);
    logger(`extractHighlightedAddition: strippedNew (${strippedNew.length} chars): "${strippedNew.substring(0, 150)}"`, 1);

    if (!strippedOld && !strippedNew) return null;

    const diffLines = computeDiff(strippedOld, strippedNew);
    logger(`extractHighlightedAddition: ${diffLines.length} diff lines computed`, 1);

    // Collect all addition lines (with or without segments)
    const additionLines = diffLines.filter(l => l.type === 'addition');
    if (additionLines.length === 0) {
        logger(`extractHighlightedAddition: no addition lines found`, 1);
        return null;
    }

    // Find the first addition line with a highlighted segment
    const firstHighlightedLine = additionLines.find(
        l => l.segments?.some(s => s.highlighted && s.text.trim()),
    );
    if (!firstHighlightedLine) {
        logger(`extractHighlightedAddition: no highlighted addition line found`, 1);
        return null;
    }

    const fullLineText = firstHighlightedLine.text.trim();
    if (fullLineText.length < 10) {
        logger(`extractHighlightedAddition: first highlighted line too short (${fullLineText.length} chars)`, 1);
        return null;
    }

    // Extract only the highlighted (diff-char-add) portion.
    // truncateSegments only truncates non-highlighted segments, so the
    // highlighted text from segments is accurate.
    let selectText = firstHighlightedLine.segments!
        .filter(s => s.highlighted)
        .map(s => s.text)
        .join('')
        .trim();
    selectText = stripEllipsis(selectText);
    if (!selectText || selectText.length < 5) {
        logger(`extractHighlightedAddition: selectText too short after stripping`, 1);
        return null;
    }

    // Build searchText from the full line, truncated to a window centered
    // around the highlighted portion so it always contains selectText.
    let searchText = fullLineText;
    const windowSize = Math.max(200, selectText.length + 40);
    if (searchText.length > windowSize) {
        const hlIdx = searchText.indexOf(selectText);
        if (hlIdx !== -1) {
            const margin = Math.floor((windowSize - selectText.length) / 2);
            const start = Math.max(0, hlIdx - margin);
            searchText = searchText.substring(start, start + windowSize);
        } else {
            searchText = searchText.substring(0, windowSize);
        }
    }
    searchText = stripEllipsis(searchText);

    // For multi-line edits, include the last addition line so the selection
    // can span the entire edited range (not just the first line).
    let endSearchText: string | undefined;
    if (additionLines.length > 1) {
        const lastLine = additionLines[additionLines.length - 1];
        let endText = lastLine.text.trim();
        if (endText.length > 100) endText = endText.slice(-100);
        endText = stripEllipsis(endText);
        if (endText && endText.length >= 5) {
            endSearchText = endText;
        }
    }

    logger(`extractHighlightedAddition: searchText="${searchText.substring(0, 80)}", selectText="${selectText.substring(0, 80)}"${endSearchText ? `, endSearchText="${endSearchText.substring(0, 80)}"` : ''}`, 1);
    return { searchText, selectText, endSearchText };
}

/**
 * Extract a search-friendly plain-text term from simplified HTML.
 * Strips HTML tags (handling citations, annotations, images) and takes
 * the first meaningful line, truncated to a reasonable length for search.
 */
function extractSearchTerm(html: string): string | null {
    logger(`extractSearchTerm: input html (${html.length} chars): "${html.substring(0, 200)}"`, 1);

    const plainText = stripHtmlTags(html);
    logger(`extractSearchTerm: after stripHtmlTags (${plainText.length} chars): "${plainText.substring(0, 200)}"`, 1);

    if (!plainText) {
        logger(`extractSearchTerm: plainText is empty after stripping`, 1);
        return null;
    }

    // Take the first non-empty line as the search term.
    // This avoids multi-line search issues with ProseMirror.
    const lines = plainText.split('\n').filter(l => l.trim());
    logger(`extractSearchTerm: ${lines.length} non-empty lines found`, 1);
    if (lines.length === 0) return null;

    let term = lines[0].trim();
    logger(`extractSearchTerm: first line (${term.length} chars): "${term.substring(0, 200)}"`, 1);

    // Truncate to a reasonable length — long terms may not match well
    // due to whitespace normalization differences between simplified HTML
    // and ProseMirror's text representation.
    if (term.length > 100) {
        term = term.substring(0, 100);
        logger(`extractSearchTerm: truncated to 100 chars`, 1);
    }

    term = stripEllipsis(term);
    return term;
}

/**
 * Find text in the note editor, select it, and scroll to it using
 * ProseMirror's TextSelection and scrollIntoView — no search bar shown.
 *
 * @param searchText - Text to locate in the editor DOM (first addition line).
 * @param selectText - Optional narrower text to actually select. When
 *   provided, the function first checks if it's unique in the note. If
 *   unique it selects just that text; otherwise it locates `searchText`
 *   (the wider context) and selects the `selectText` portion within it.
 * @param endSearchText - Optional text of the last addition line. When
 *   provided (multi-line edits), the selection spans from the start of
 *   `selectText` within `searchText` to the end of `endSearchText`.
 */
async function selectAndScrollInNoteEditor(
    itemId: number,
    searchText: string,
    selectText?: string,
    endSearchText?: string,
): Promise<boolean> {
    const maxWaitMs = 3000;
    const pollIntervalMs = 100;
    const startTime = Date.now();

    logger(`selectAndScrollInNoteEditor: polling for editor view (itemId=${itemId})`, 1);

    while (Date.now() - startTime < maxWaitMs) {
        const view = getNoteEditorView(itemId);
        if (view?.dom) {
            logger(`selectAndScrollInNoteEditor: view found after ${Date.now() - startTime}ms`, 1);

            const { textNodes, fullText } = buildEditorTextMap(view.dom);

            // Determine which character range to select
            let rangeStart: number;
            let rangeEnd: number;

            if (endSearchText) {
                // Multi-line edit: select from start of selectText (within
                // searchText) to end of endSearchText.
                const ctxIdx = fullText.indexOf(searchText);
                if (ctxIdx === -1) {
                    logger(`selectAndScrollInNoteEditor: searchText not found in DOM`, 1);
                    return false;
                }

                // Start from the selectText (changed portion) within the
                // first addition line, not from the shared prefix.
                if (selectText) {
                    const withinIdx = searchText.indexOf(selectText);
                    rangeStart = withinIdx !== -1 ? ctxIdx + withinIdx : ctxIdx;
                } else {
                    rangeStart = ctxIdx;
                }

                // Find endSearchText after the start position
                const endIdx = fullText.indexOf(endSearchText, rangeStart);
                if (endIdx !== -1) {
                    rangeEnd = endIdx + endSearchText.length;
                } else {
                    // Fallback: select to end of searchText
                    logger(`selectAndScrollInNoteEditor: endSearchText not found, falling back to searchText range`, 1);
                    rangeEnd = ctxIdx + searchText.length;
                }
                logger(`selectAndScrollInNoteEditor: multi-line range ${rangeStart}-${rangeEnd}`, 1);
            } else if (selectText && selectText !== searchText) {
                // Single-line edit: check if selectText is unique in the note
                const firstIdx = fullText.indexOf(selectText);
                const secondIdx = firstIdx !== -1
                    ? fullText.indexOf(selectText, firstIdx + 1)
                    : -1;

                if (firstIdx !== -1 && secondIdx === -1) {
                    // selectText is unique → select it directly
                    logger(`selectAndScrollInNoteEditor: selectText is unique, selecting directly`, 1);
                    rangeStart = firstIdx;
                    rangeEnd = firstIdx + selectText.length;
                } else {
                    // selectText appears multiple times (or not at all) —
                    // use searchText for disambiguation
                    logger(`selectAndScrollInNoteEditor: selectText not unique (first=${firstIdx}, second=${secondIdx}), using searchText context`, 1);
                    const ctxIdx = fullText.indexOf(searchText);
                    if (ctxIdx !== -1) {
                        const withinIdx = searchText.indexOf(selectText);
                        if (withinIdx !== -1) {
                            rangeStart = ctxIdx + withinIdx;
                            rangeEnd = rangeStart + selectText.length;
                        } else {
                            rangeStart = ctxIdx;
                            rangeEnd = ctxIdx + searchText.length;
                        }
                    } else if (firstIdx !== -1) {
                        rangeStart = firstIdx;
                        rangeEnd = firstIdx + selectText.length;
                    } else {
                        logger(`selectAndScrollInNoteEditor: neither searchText nor selectText found in DOM`, 1);
                        return false;
                    }
                }
            } else {
                // No separate selectText — find and select searchText
                const idx = fullText.indexOf(searchText);
                if (idx === -1) {
                    logger(`selectAndScrollInNoteEditor: text not found in DOM: "${searchText}"`, 1);
                    return false;
                }
                rangeStart = idx;
                rangeEnd = idx + searchText.length;
            }

            // Map character range to DOM nodes
            const match = resolveRangeInTextMap(textNodes, rangeStart, rangeEnd);
            if (!match) {
                logger(`selectAndScrollInNoteEditor: failed to map char range to DOM nodes`, 1);
                return false;
            }

            const fromPos = view.posAtDOM(match.startNode, match.startOffset);
            const toPos = view.posAtDOM(match.endNode, match.endOffset);
            logger(`selectAndScrollInNoteEditor: mapped to positions ${fromPos}-${toPos}`, 1);

            // Use the selection's constructor (TextSelection) to create a range selection.
            const TextSelection = view.state.selection.constructor;
            const tr = view.state.tr.setSelection(
                TextSelection.create(view.state.doc, fromPos, toPos)
            );
            view.dispatch(tr);

            // Scroll the selection start into the center of the editor's
            // scrollable container. We set scrollTop directly because
            // element.scrollIntoView() doesn't work reliably inside
            // Zotero's note-editor iframe.
            try {
                const scrollContainer = findScrollContainer(view.dom);
                if (scrollContainer) {
                    const coords = view.coordsAtPos(fromPos);
                    const containerRect = scrollContainer.getBoundingClientRect();
                    const targetScrollTop = scrollContainer.scrollTop
                        + (coords.top - containerRect.top)
                        - scrollContainer.clientHeight / 2;
                    scrollContainer.scrollTop = Math.max(0, targetScrollTop);
                }
            } catch (err: any) {
                logger(`selectAndScrollInNoteEditor: scroll failed (${err?.message})`, 1);
            }

            // Defer focus so it runs after the current click event finishes
            // processing (the sidebar click steals focus back otherwise).
            // Focus the iframe element in the parent window first, then the
            // ProseMirror view inside it.
            const iframeDoc = view.dom.ownerDocument;
            const iframeEl = iframeDoc?.defaultView?.frameElement;
            setTimeout(() => {
                try {
                    if (iframeEl && typeof (iframeEl as HTMLElement).focus === 'function') {
                        (iframeEl as HTMLElement).focus();
                    }
                    view.focus();
                } catch {
                    // Best-effort — selection is still set even without focus
                }
            }, 50);

            logger(`selectAndScrollInNoteEditor: selection set and scrolled into view`, 1);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    logger(`selectAndScrollInNoteEditor: timed out after ${maxWaitMs}ms`, 1);
    return false;
}

/**
 * Walk all text nodes in the editor DOM and build a flat text string with
 * a mapping from character offsets back to DOM nodes.
 */
function buildEditorTextMap(editorDOM: HTMLElement): {
    textNodes: { node: Node; start: number }[];
    fullText: string;
} {
    const walker = editorDOM.ownerDocument.createTreeWalker(editorDOM, 4 /* SHOW_TEXT */);
    const textNodes: { node: Node; start: number }[] = [];
    let fullText = '';

    while (walker.nextNode()) {
        textNodes.push({ node: walker.currentNode, start: fullText.length });
        fullText += walker.currentNode.textContent || '';
    }

    return { textNodes, fullText };
}

/**
 * Given a character range [startIdx, endIdx) in the flat text built by
 * `buildEditorTextMap`, resolve it to the corresponding DOM nodes and
 * offsets. Handles ranges that span multiple text nodes (e.g. across
 * inline elements like bold, italic, links, citations).
 */
function resolveRangeInTextMap(
    textNodes: { node: Node; start: number }[],
    startIdx: number,
    endIdx: number,
): { startNode: Node; startOffset: number; endNode: Node; endOffset: number } | null {
    let startNode: Node | null = null;
    let startOffset = 0;
    let endNode: Node | null = null;
    let endOffset = 0;

    for (const tn of textNodes) {
        const nodeEnd = tn.start + (tn.node.textContent?.length || 0);
        if (!startNode && startIdx < nodeEnd) {
            startNode = tn.node;
            startOffset = startIdx - tn.start;
        }
        if (endIdx <= nodeEnd) {
            endNode = tn.node;
            endOffset = endIdx - tn.start;
            break;
        }
    }

    if (!startNode || !endNode) return null;
    return { startNode, startOffset, endNode, endOffset };
}

/**
 * Walk up the DOM from `el` to find the nearest scrollable ancestor
 * (overflow-y: auto or scroll with content taller than the viewport).
 */
function findScrollContainer(el: HTMLElement): HTMLElement | null {
    const win = el.ownerDocument.defaultView;
    if (!win) return null;
    let current = el.parentElement;
    while (current) {
        const style = win.getComputedStyle(current);
        if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')
            && current.scrollHeight > current.clientHeight) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

/**
 * Strip leading/trailing ellipsis characters (`…`) that diff truncation
 * helpers (truncateSegments, truncateContext) may have inserted. These
 * won't match actual note text.
 */
function stripEllipsis(term: string): string {
    let result = term;
    if (result.startsWith('…')) result = result.substring(1);
    if (result.endsWith('…')) result = result.slice(0, -1);
    return result.trim();
}

/**
 * Get the ProseMirror EditorView from an open note editor instance.
 * Returns null if the editor isn't available or hasn't finished initializing.
 */
function getNoteEditorView(itemId: number): any | null {
    try {
        const instances: any[] = (Zotero as any).Notes?._editorInstances;
        if (!instances) return null;

        const inst = instances.find((e: any) => e.itemID === itemId);
        if (!inst?._iframeWindow) return null;

        const wrappedJS = inst._iframeWindow.wrappedJSObject;
        if (!wrappedJS) return null;

        const innerEditor = wrappedJS._currentEditorInstance;
        if (!innerEditor?._editorCore?.view) return null;

        return innerEditor._editorCore.view;
    } catch (err: any) {
        logger(`getNoteEditorView: exception: ${err?.message || err}`, 1);
        return null;
    }
}