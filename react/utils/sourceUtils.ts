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

export function getDisplayNameFromItem(item: Zotero.Item, count: number | null = null, noteTitleLength: number = MAX_NOTE_TITLE_LENGTH): string {
    let displayName: string;

    if (item.isNote()) {
        displayName = truncateText(item.getNoteTitle(), noteTitleLength);
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
    let formatted_citation: string;
    if (item.isNote()) {
        // @ts-ignore unescapeHTML exists
        let plainText: string = Zotero.Utilities.unescapeHTML(item.getNote());
        // Strip the title from the beginning of the content to avoid duplication
        const noteTitle = item.getNoteTitle();
        if (noteTitle && plainText.startsWith(noteTitle)) {
            plainText = plainText.substring(noteTitle.length).trim();
        }
        formatted_citation = truncateText(plainText, MAX_NOTE_CONTENT_LENGTH);
    } else {
        formatted_citation = Zotero.Beaver?.citationService?.formatBibliography(item) ?? '';
    }
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
 * Clear (collapse) the selection in an open note editor.
 * Called after an edit is applied or undone so the selection doesn't shift
 * to unrelated text when ProseMirror remaps through document changes.
 */
export function clearNoteEditorSelection(libraryId: number, zoteroKey: string): void {
    const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
    if (!itemId) return;

    // Wait for the Notifier to propagate the content change, then collapse
    // the selection to a cursor so it doesn't highlight unrelated text.
    setTimeout(() => {
        try {
            const view = getNoteEditorView(itemId);
            if (!view?.dom) return;

            const SelectionBase = Object.getPrototypeOf(
                Object.getPrototypeOf(view.state.selection)
            ).constructor;
            const TextSelectionClass = SelectionBase.atStart(view.state.doc).constructor;
            // Collapse to cursor at the selection's start (mapped to the edit point)
            const cursorPos = Math.min(view.state.selection.from, view.state.doc.content.size);
            const selection = TextSelectionClass.create(view.state.doc, cursorPos);
            view.dispatch(view.state.tr.setSelection(selection));
        } catch {
            // Best-effort — a stale selection is cosmetic, not critical
        }
    }, 150);
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
    undoBeforeContext?: string,
    undoAfterContext?: string,
    targetBeforeContext?: string,
    targetAfterContext?: string,
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
    let selectOffsetInSearch: number | undefined;
    let contextualSearches: Array<{ searchText: string; selectText: string; selectOffsetInSearch: number }> = [];

    // For applied edits, highlight the added text; for pending/undone edits,
    // highlight the text that will be replaced (the deleted portion).
    const diffTarget = isApplied ? 'addition' : 'deletion';
    const fallbackHtml = isApplied ? newString : oldString;

    const result = extractHighlightedDiffText(oldString, newString, diffTarget);
    if (result) {
        searchText = result.searchText;
        selectText = result.selectText;
        endSearchText = result.endSearchText;
        selectOffsetInSearch = result.selectOffsetInSearch;
        logger(`openNoteAndSearchEdit: extractHighlightedDiffText(${diffTarget}): searchText="${searchText.substring(0, 80)}", selectText="${selectText.substring(0, 80)}", selectOffsetInSearch=${selectOffsetInSearch}${endSearchText ? `, endSearchText="${endSearchText.substring(0, 80)}"` : ''}`, 1);
    } else {
        // Fall back when there's no char-level diff highlight.
        if (diffTarget === 'deletion') {
            // For pending pure insertions, search for the END of the old text
            // so we scroll to the insertion point.
            searchText = extractSearchTermEnd(fallbackHtml) || extractSearchTerm(fallbackHtml);
        } else {
            // For applied pure deletions (nothing highlighted on the addition
            // side), find context around the edit point in the new text so we
            // scroll to where the deletion happened, not the paragraph start.
            if (!newString && undoBeforeContext && undoAfterContext) {
                // For full deletions with undo context, search for the seam
                // (before + after context concatenated) in the note's plain text.
                const seamText = stripHtmlTags(undoBeforeContext + undoAfterContext);
                // Use the last ~60 chars before + first ~40 chars after as search text
                const beforePart = seamText.substring(Math.max(0, seamText.length / 2 - 60), Math.floor(seamText.length / 2));
                const afterPart = seamText.substring(Math.floor(seamText.length / 2), Math.floor(seamText.length / 2) + 40);
                const seamSearch = (beforePart + afterPart).trim();
                searchText = seamSearch.length >= 10 ? seamSearch : null;
                logger(`openNoteAndSearchEdit: using undo context seam for applied deletion: "${searchText?.substring(0, 80)}"`, 1);
            }
            if (!searchText) {
                searchText = extractEditPointContext(oldString, newString) || extractSearchTerm(fallbackHtml);
            }
        }
        logger(`openNoteAndSearchEdit: fell back to fallback search: ${searchText ? `"${searchText}"` : 'null'}`, 1);
    }

    // When validation persisted explicit target context for an ambiguous raw
    // match (e.g. duplicate citations with different refs), derive a text-level
    // anchor for the editor search. The editor matcher operates on flattened
    // plain text, so we convert the raw-note context to nearby text here
    // instead of passing raw HTML into selectAndScrollInNoteEditor.
    if (!endSearchText) {
        contextualSearches = extractTargetContextSearches(
            targetBeforeContext,
            isApplied ? newString : oldString,
            targetAfterContext,
            selectText,
        );
        const contextualSearch = contextualSearches[0];
        if (contextualSearch) {
            searchText = contextualSearch.searchText;
            selectText = contextualSearch.selectText;
            selectOffsetInSearch = contextualSearch.selectOffsetInSearch;
            logger(`openNoteAndSearchEdit: using target-context search "${searchText.substring(0, 80)}"`, 1);
        }
    }

    if (!searchText) {
        logger(`openNoteAndSearchEdit: no search text resolved, aborting search`, 1);
        return;
    }
    logger(`openNoteAndSearchEdit: final searchText="${searchText}", selectText=${selectText ? `"${selectText}"` : 'undefined'}, endSearchText=${endSearchText ? `"${endSearchText}"` : 'undefined'}`, 1);

    // Wait for the editor instance to be available and initialized,
    // then select the text and scroll to it.
    let found = await selectAndScrollInNoteEditor(itemId, searchText, selectText, endSearchText, selectOffsetInSearch);

    // If the first target-context search variant failed, try alternate
    // rendered variants before falling back to generic search terms.
    if (!found && contextualSearches.length > 1) {
        for (const candidate of contextualSearches.slice(1)) {
            logger(`openNoteAndSearchEdit: retrying alternate target-context search "${candidate.searchText.substring(0, 80)}"`, 1);
            found = await selectAndScrollInNoteEditor(
                itemId,
                candidate.searchText,
                candidate.selectText,
                undefined,
                candidate.selectOffsetInSearch,
            );
            if (found) break;
        }
    }

    // Retry without placeholder tokens ([citation], [image]) that won't
    // match the editor DOM — citations render as formatted text and images
    // have no text node. This handles cases where stripHtmlTags couldn't
    // recover the citation label (e.g. item not in local library).
    if (!found && /\[(citation|image)\]/.test(searchText)) {
        const stripPlaceholders = (s: string) => s.replace(/\s*\[(citation|image)\]\s*/g, ' ').trim();
        const cleanSearch = stripPlaceholders(searchText);
        const cleanSelect = selectText ? stripPlaceholders(selectText) : undefined;
        const cleanEnd = endSearchText ? stripPlaceholders(endSearchText) : undefined;
        if (cleanSearch.length >= 10) {
            logger(`openNoteAndSearchEdit: retrying without placeholder tokens: "${cleanSearch.substring(0, 80)}"`, 1);
            found = await selectAndScrollInNoteEditor(itemId, cleanSearch, cleanSelect, cleanEnd);
        }
    }

    // Fallback: only applied edits should try the opposite text. For pending,
    // rejected, and undone actions the note is expected to contain oldString,
    // so jumping to newString can select the wrong citation entirely.
    if (!found && isApplied) {
        const fallbackText = extractSearchTerm(oldString);
        if (fallbackText) {
            logger(`openNoteAndSearchEdit: primary search failed, trying fallback: "${fallbackText}"`, 1);
            await selectAndScrollInNoteEditor(itemId, fallbackText);
        }
    }
}

/**
 * Extract search and selection text from the diff between old and new HTML.
 *
 * @param targetType - Which diff line type to extract from:
 *   `'addition'` for applied edits (find the new text in the note),
 *   `'deletion'` for pending/undone edits (find the old text in the note).
 *
 * Returns:
 *  - `searchText`: the first target-type line (used for locating the edit and
 *    for disambiguation when `selectText` is not unique).
 *  - `selectText`: the highlighted (char-level diff) portion of the first
 *    target-type line — the narrowest text we want to select.
 *  - `endSearchText` (optional): the last target-type line text, returned only
 *    for multi-line edits so the selection can span the full edit range.
 *
 * Returns null when no target-type line with a highlight is found or the
 * result is too short to be a useful search term.
 */
function extractHighlightedDiffText(
    oldHtml: string,
    newHtml: string,
    targetType: 'addition' | 'deletion',
): { searchText: string; selectText: string; selectOffsetInSearch?: number; endSearchText?: string } | null {
    const strippedOld = stripHtmlTags(oldHtml);
    const strippedNew = stripHtmlTags(newHtml);
    logger(`extractHighlightedDiffText(${targetType}): strippedOld (${strippedOld.length} chars): "${strippedOld.substring(0, 150)}"`, 1);
    logger(`extractHighlightedDiffText(${targetType}): strippedNew (${strippedNew.length} chars): "${strippedNew.substring(0, 150)}"`, 1);

    if (!strippedOld && !strippedNew) return null;

    const diffLines = computeDiff(strippedOld, strippedNew);
    logger(`extractHighlightedDiffText(${targetType}): ${diffLines.length} diff lines computed`, 1);

    // Collect all lines of the target type (with or without segments)
    const targetLines = diffLines.filter(l => l.type === targetType);
    if (targetLines.length === 0) {
        logger(`extractHighlightedDiffText(${targetType}): no ${targetType} lines found`, 1);
        return null;
    }

    // Find the first target line with a highlighted segment
    const firstHighlightedLine = targetLines.find(
        l => l.segments?.some(s => s.highlighted && s.text.trim()),
    );
    if (!firstHighlightedLine) {
        logger(`extractHighlightedDiffText(${targetType}): no highlighted ${targetType} line found`, 1);
        return null;
    }

    const fullLineText = firstHighlightedLine.text.trim();
    if (fullLineText.length < 10) {
        logger(`extractHighlightedDiffText(${targetType}): first highlighted line too short (${fullLineText.length} chars)`, 1);
        return null;
    }

    // Extract only the highlighted (char-level diff) portion.
    // truncateSegments only truncates non-highlighted segments, so the
    // highlighted text from segments is accurate.
    let selectText = firstHighlightedLine.segments!
        .filter(s => s.highlighted)
        .map(s => s.text)
        .join('')
        .trim();
    selectText = stripEllipsis(selectText);
    if (!selectText || selectText.length < 2) {
        logger(`extractHighlightedDiffText(${targetType}): selectText too short after stripping`, 1);
        return null;
    }

    // Find the correct position of selectText in fullLineText.
    // selectText may appear multiple times (e.g., "the" in
    // "Why did the German police officer arrest the battery?").
    // Use adjacent segment text as context to disambiguate.
    const segs = firstHighlightedLine.segments!;
    let selectOffset = fullLineText.indexOf(selectText);
    let prefixContext = '';
    for (const seg of segs) {
        if (seg.highlighted) break;
        prefixContext = seg.text; // keep last non-highlighted segment before highlight
    }
    prefixContext = prefixContext.replace(/^…+/, ''); // strip truncation ellipsis
    if (prefixContext.length > 0) {
        const ctxLen = Math.min(15, prefixContext.length);
        const ctx = prefixContext.slice(-ctxLen);
        const combined = ctx + selectText;
        const combinedIdx = fullLineText.indexOf(combined);
        if (combinedIdx !== -1) {
            selectOffset = combinedIdx + ctx.length;
        }
    }

    // Build searchText from the full line, truncated to a window centered
    // around the highlighted portion so it always contains selectText.
    let searchText = fullLineText;
    let searchTextStart = 0; // track where the window starts within fullLineText
    const windowSize = Math.max(200, selectText.length + 40);
    if (searchText.length > windowSize) {
        if (selectOffset !== -1) {
            const margin = Math.floor((windowSize - selectText.length) / 2);
            searchTextStart = Math.max(0, selectOffset - margin);
            searchText = searchText.substring(searchTextStart, searchTextStart + windowSize);
        } else {
            searchText = searchText.substring(0, windowSize);
        }
    }
    searchText = stripEllipsis(searchText);

    // Compute offset of selectText within searchText for downstream
    // disambiguation (avoids indexOf which may find the wrong occurrence).
    const selectOffsetInSearch = selectOffset !== -1
        ? selectOffset - searchTextStart
        : undefined;

    // For multi-line edits, include the last target line so the selection
    // can span the entire edited range (not just the first line).
    let endSearchText: string | undefined;
    if (targetLines.length > 1) {
        const lastLine = targetLines[targetLines.length - 1];
        let endText = lastLine.text.trim();
        if (endText.length > 100) endText = endText.slice(-100);
        endText = stripEllipsis(endText);
        if (endText && endText.length >= 5) {
            endSearchText = endText;
        }
    }

    logger(`extractHighlightedDiffText(${targetType}): searchText="${searchText.substring(0, 80)}", selectText="${selectText.substring(0, 80)}", selectOffsetInSearch=${selectOffsetInSearch}${endSearchText ? `, endSearchText="${endSearchText.substring(0, 80)}"` : ''}`, 1);
    return { searchText, selectText, selectOffsetInSearch, endSearchText };
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
 * Like extractSearchTerm but takes the LAST line and its trailing portion.
 * Used for pending pure insertions so we scroll to the insertion point
 * (end of existing text) rather than the beginning of the paragraph.
 */
function extractSearchTermEnd(html: string): string | null {
    const plainText = stripHtmlTags(html);
    if (!plainText) return null;

    const lines = plainText.split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    let term = lines[lines.length - 1].trim();
    if (term.length > 100) {
        term = term.slice(-100);
    }
    term = stripEllipsis(term);
    return term || null;
}

/**
 * Find the context around the edit point in the new text by comparing
 * old and new HTML. Used for applied pure deletions where nothing was
 * added — ensures we scroll to where the deletion happened rather than
 * the beginning of the paragraph.
 */
function extractEditPointContext(oldHtml: string, newHtml: string): string | null {
    const oldText = stripHtmlTags(oldHtml);
    const newText = stripHtmlTags(newHtml);
    if (!oldText || !newText) return null;

    // Find where old and new text first diverge
    let prefixLen = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
        prefixLen++;
    }

    // If texts are identical, nothing to search for
    if (prefixLen === oldText.length && prefixLen === newText.length) return null;

    // Extract context around the edit point from the new text,
    // biased toward text before the edit (recognizable to the user).
    const contextBefore = 60;
    const contextAfter = 40;
    const start = Math.max(0, prefixLen - contextBefore);
    const end = Math.min(newText.length, prefixLen + contextAfter);

    let term = newText.substring(start, end).trim();
    term = stripEllipsis(term);
    if (!term || term.length < 10) return null;
    if (term.length > 100) term = term.substring(0, 100);

    logger(`extractEditPointContext: editPoint=${prefixLen}, context="${term.substring(0, 80)}"`, 1);
    return term;
}

function normalizeSearchFragment(html: string | undefined): string {
    if (!html) return '';
    return stripEllipsis(stripHtmlTags(html).replace(/\s+/g, ' ').trim());
}

function appendCitationPageWithStyle(tag: string, label: string, style: 'short' | 'word'): string {
    const pageMatch = tag.match(/\bpage="([^"]*)"/);
    if (!pageMatch || !pageMatch[1]) return label;
    const page = pageMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const suffix = style === 'word' ? `, page ${page}` : `, p. ${page}`;
    const locatorWithParen = /^(.*?)(,\s*(?:p{1,2}\.|page)\s+[^)]*)(\))$/i;
    if (locatorWithParen.test(label)) {
        return label.replace(locatorWithParen, `$1${suffix}$3`);
    }
    const locatorPlain = /^(.*?)(,\s*(?:p{1,2}\.|page)\s+.*)$/i;
    if (locatorPlain.test(label)) {
        return label.replace(locatorPlain, `$1${suffix}`);
    }
    if (label.endsWith(')')) {
        return label.slice(0, -1) + suffix + ')';
    }
    return label + suffix;
}

function normalizeTargetSearchVariant(html: string, style: 'short' | 'word'): string {
    const expandedCitations = html
        .replace(
            /<citation\b(?:[^>"']|"[^"]*"|'[^']*')*\blabel="([^"]*)"(?:[^>"']|"[^"]*"|'[^']*')*\/>/gi,
            (match, label) => appendCitationPageWithStyle(match, label || '[citation]', style)
        )
        .replace(/<citation\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/gi, '[citation]');
    return stripEllipsis(stripHtmlTags(expandedCitations).replace(/\s+/g, ' ').trim());
}

function extractTargetContextSearches(
    beforeHtml: string | undefined,
    targetHtml: string,
    afterHtml: string | undefined,
    preferredSelectText?: string,
): Array<{ searchText: string; selectText: string; selectOffsetInSearch: number }> {
    const beforeText = normalizeSearchFragment(beforeHtml);
    const afterText = normalizeSearchFragment(afterHtml);
    if (!beforeText && !afterText) return [];

    const targetTextVariants = Array.from(new Set([
        normalizeSearchFragment(targetHtml),
        normalizeTargetSearchVariant(targetHtml, 'word'),
        normalizeTargetSearchVariant(targetHtml, 'short'),
    ].filter((text) => text && text.length >= 2)));
    if (targetTextVariants.length === 0) return [];

    const preferred = normalizeSearchFragment(preferredSelectText);
    const beforeTail = beforeText ? beforeText.slice(-80) : '';
    const afterHead = afterText ? afterText.slice(0, 80) : '';
    const searches: Array<{ searchText: string; selectText: string; selectOffsetInSearch: number }> = [];

    for (const targetText of targetTextVariants) {
        const selectText = preferred && targetText.includes(preferred)
            ? preferred
            : targetText;
        if (!selectText || selectText.length < 2) continue;

        const parts = [beforeTail, targetText, afterHead].filter(Boolean);
        if (parts.length === 0) continue;

        const searchText = parts.join(' ').trim();
        if (!searchText || searchText.length < 10) continue;

        const selectOffsetInTarget = targetText.indexOf(selectText);
        const selectOffsetInSearch = (beforeTail ? beforeTail.length + 1 : 0)
            + (selectOffsetInTarget >= 0 ? selectOffsetInTarget : 0);

        searches.push({
            searchText,
            selectText,
            selectOffsetInSearch,
        });
    }

    return searches;
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
/** @internal Exported for testing only. */
export async function selectAndScrollInNoteEditor(
    itemId: number,
    searchText: string,
    selectText?: string,
    endSearchText?: string,
    selectOffsetInSearch?: number,
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
                    const withinIdx = selectOffsetInSearch ?? searchText.indexOf(selectText);
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
                        // Use the pre-computed offset when available (avoids
                        // indexOf picking the wrong occurrence of selectText
                        // within searchText, e.g. "the" appearing twice).
                        const withinIdx = selectOffsetInSearch ?? searchText.indexOf(selectText);
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
            let toPos = view.posAtDOM(match.endNode, match.endOffset);

            // posAtDOM maps positions inside an inline atom's DOM (e.g.
            // citations, images) to the atom's start position, so the
            // selection ends just before the atom. Detect this and extend
            // toPos to include the full atom.
            try {
                const $to = view.state.doc.resolve(toPos);
                if ($to.nodeAfter?.isAtom && $to.nodeAfter.isInline) {
                    const atomDom = view.nodeDOM(toPos);
                    if (atomDom && (atomDom === match.endNode || atomDom.contains(match.endNode))) {
                        toPos += $to.nodeAfter.nodeSize;
                    }
                }
            } catch { /* best effort */ }

            logger(`selectAndScrollInNoteEditor: mapped to positions ${fromPos}-${toPos}`, 1);

            // Create a TextSelection for the target range.
            // IMPORTANT: We must reliably get the TextSelection class, not just
            // use `view.state.selection.constructor`. If the current selection is
            // a NodeSelection (e.g., after clicking a citation/image/math block),
            // its `.create()` method has a different signature and silently
            // produces the wrong selection type.
            //
            // We can't use Selection.fromJSON here because Firefox's Xray
            // wrappers prevent the content-compartment function from reading
            // properties on objects created in the chrome compartment. Instead,
            // we use Selection.atStart() which always returns a TextSelection —
            // then grab its constructor. All arguments stay within the content
            // compartment, avoiding cross-compartment issues.
            let selection: any;
            try {
                const SelectionBase = Object.getPrototypeOf(
                    Object.getPrototypeOf(view.state.selection)
                ).constructor;
                const TextSelectionClass = SelectionBase.atStart(view.state.doc).constructor;
                selection = TextSelectionClass.create(view.state.doc, fromPos, toPos);
            } catch (selErr: any) {
                logger(`selectAndScrollInNoteEditor: TextSelection lookup failed (${selErr?.message}), using constructor fallback`, 1);
                const Ctor = view.state.selection.constructor;
                selection = Ctor.create(view.state.doc, fromPos, toPos);
            }
            const tr = view.state.tr.setSelection(selection).scrollIntoView();
            view.dispatch(tr);

            // Verify the selection was actually applied
            const actualSel = view.state.selection;
            logger(`selectAndScrollInNoteEditor: selection after dispatch: from=${actualSel.from}, to=${actualSel.to} (expected ${fromPos}-${toPos})`, 1);

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
            // ProseMirror view inside it. We retry a few times because React
            // re-renders and event bubbling can steal focus back after our
            // first attempt.
            const iframeDoc = view.dom.ownerDocument;
            const iframeEl = iframeDoc?.defaultView?.frameElement;
            const focusEditor = () => {
                try {
                    if (iframeEl && typeof (iframeEl as HTMLElement).focus === 'function') {
                        (iframeEl as HTMLElement).focus();
                    }
                    view.focus();
                } catch {
                    // Best-effort — selection is still set even without focus
                }
            };
            setTimeout(focusEditor, 50);
            setTimeout(focusEditor, 200);

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
/** @internal Exported for testing only. */
export function buildEditorTextMap(editorDOM: HTMLElement): {
    textNodes: { node: Node; start: number }[];
    fullText: string;
} {
    const walker = editorDOM.ownerDocument.createTreeWalker(editorDOM, 4 /* SHOW_TEXT */);
    const textNodes: { node: Node; start: number }[] = [];
    let fullText = '';

    // Block-level tag names — when the tree walker crosses from one block
    // ancestor into another, we insert a space so that text from adjacent
    // paragraphs/headings doesn't run together. This matches how
    // extractTargetContextSearches joins context fragments with spaces.
    const blockTags = new Set([
        'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'LI', 'TR', 'BLOCKQUOTE', 'PRE', 'TABLE', 'UL', 'OL',
        'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
    ]);

    function getBlockAncestor(node: Node): Node {
        let current = node.parentNode;
        while (current && current !== editorDOM) {
            if ((current as Element).tagName && blockTags.has((current as Element).tagName)) {
                return current;
            }
            current = current.parentNode;
        }
        return editorDOM;
    }

    let prevBlock: Node | null = null;

    while (walker.nextNode()) {
        const currentBlock = getBlockAncestor(walker.currentNode);
        if (prevBlock !== null && currentBlock !== prevBlock && fullText.length > 0) {
            fullText += ' ';
        }
        prevBlock = currentBlock;
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
/** @internal Exported for testing only. */
export function resolveRangeInTextMap(
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
            // Clamp to 0: if startIdx falls on a virtual block separator
            // (inserted by buildEditorTextMap between blocks), it may be
            // before this text node's start position.
            startOffset = Math.max(0, startIdx - tn.start);
        }
        if (endIdx <= nodeEnd) {
            endNode = tn.node;
            endOffset = Math.max(0, endIdx - tn.start);
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
/** @internal Exported for testing only. */
export function findScrollContainer(el: HTMLElement): HTMLElement | null {
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
/** @internal Exported for testing only. */
export function stripEllipsis(term: string): string {
    let result = term;
    if (result.startsWith('…')) result = result.substring(1);
    if (result.endsWith('…')) result = result.slice(0, -1);
    return result.trim();
}

/**
 * Get the ProseMirror EditorView from an open note editor instance.
 * Returns null if the editor isn't available or hasn't finished initializing.
 *
 * A note can have multiple editor instances open simultaneously (e.g., one in
 * a tab and one in a window). Since `openNoteById` opens notes in a tab by
 * default, we prefer tab instances over other viewModes. Picking the wrong
 * instance would set the selection on a non-visible editor — the operation
 * would log success but nothing would appear on screen.
 */
/** @internal Exported for testing only. */
export function getNoteEditorView(itemId: number): any | null {
    try {
        const instances: any[] = (Zotero as any).Notes?._editorInstances;
        if (!instances) return null;

        const matching = instances.filter((e: any) => e.itemID === itemId);
        if (matching.length === 0) return null;

        // Prefer tab instance (openNoteById opens in a tab), then any other
        const inst = matching.find((e: any) => e.viewMode === 'tab')
            || matching[0];

        logger(`getNoteEditorView: found instance viewMode=${inst.viewMode}, total matching=${matching.length}`, 1);

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
