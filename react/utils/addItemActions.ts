import { CreateItemProposedAction, CreateItemProposedData, CreateItemResultData } from '../types/agentActions/items';
import { ExternalReference, NormalizedPublicationType } from '../types/externalReferences';
import { logger } from '../../src/utils/logger';
import { getZoteroTargetContext } from '../../src/utils/zoteroUtils';
import { scheduleBackgroundTask, generateTaskId, isPdfFetchInProgress, deduplicatedSync } from '../../src/utils/backgroundTasks';
import { ensureItemSynced } from '../../src/utils/sync';

const SAVE_ATTACHMENTS_WITH_TRANSLATORS = false;


/** Options for importing items */
export interface ImportItemOptions {
    /** Target library ID. If not provided, uses current context */
    libraryId?: number;
    /** Collection to add the item to */
    collectionId?: number;
    /** Whether to select the item after import */
    selectAfterImport?: boolean;
    /** 
     * Skip scheduling background PDF fetch. 
     * Set to true when the caller will handle PDF fetching separately (e.g., applyCreateItemData).
     * Default: false (PDF fetch is scheduled)
     */
    skipBackgroundPdfFetch?: boolean;
}

/**
 * Resolves import options to get the target library and collection.
 * If library is not editable, falls back to user library.
 */
async function resolveImportTarget(options?: ImportItemOptions): Promise<{
    libraryId: number;
    collectionId: number | null;
}> {
    let libraryId = options?.libraryId;
    let collectionId = options?.collectionId ?? null;
    
    // If no library specified, get from current context
    if (libraryId === undefined) {
        const context = await getZoteroTargetContext();
        libraryId = context.targetLibraryId ?? Zotero.Libraries.userLibraryID;
        
        // Get collection from context if not specified
        if (collectionId === null && context.collectionToAddTo) {
            collectionId = context.collectionToAddTo.id;
        }
    }
    
    // Check if library is editable
    const library = Zotero.Libraries.get(libraryId);
    if (!library || !library.editable) {
        logger(`resolveImportTarget: Library ${libraryId} is not editable, falling back to user library`, 2);
        libraryId = Zotero.Libraries.userLibraryID;
        collectionId = null; // Can't use collection from different library
    }
    
    return { libraryId, collectionId };
}

// Helper to map publication types
function mapPublicationType(types: NormalizedPublicationType[] | undefined): string {
    if (!types || types.length === 0) return 'journalArticle';
    
    const type = types[0];
    switch (type) {
        case 'journal_article': return 'journalArticle';
        case 'conference_paper': return 'conferencePaper';
        case 'book': return 'book';
        case 'book_chapter': return 'bookSection';
        case 'review': return 'journalArticle';
        case 'meta_analysis': return 'journalArticle';
        case 'editorial': return 'newsArticle';
        case 'case_report': return 'report';
        case 'clinical_trial': return 'journalArticle';
        case 'dissertation': return 'thesis';
        case 'preprint': return 'preprint';
        case 'dataset': return 'dataset';
        case 'report': return 'report';
        case 'news': return 'newsArticle';
        default: return 'document';
    }
}

/**
 * ATTEMPT 1: Use Zotero's Translation Architecture
 * This is preferred because it handles metadata fetching automatically.
 * PDF fetching is handled separately by schedulePdfFetchTask() to avoid
 * Zotero opening a visible browser window for CAPTCHA challenges.
 */
async function tryImportFromIdentifiers(identifiers: any, libraryId: number): Promise<Zotero.Item | null> {
    const translate = new (Zotero as any).Translate.Search();
    
    // Determine which identifier to use (DOI is usually best)
    const identifier: Record<string, string> = {};
    if (identifiers.doi) identifier.DOI = identifiers.doi;
    else if (identifiers.isbn) identifier.ISBN = identifiers.isbn;
    else if (identifiers.pmid) identifier.PMID = identifiers.pmid;
    else if (identifiers.arXivID) identifier.arXiv = identifiers.arXivID;
    else return null;

    translate.setIdentifier(identifier);

    // Get valid translators for this identifier
    const translators = await translate.getTranslators();
    if (!translators.length) return null;

    translate.setTranslator(translators);

    // Execute translation
    // Returns an array of Zotero.Item objects
    // saveAttachments: false to prevent Zotero from opening a visible browser window
    // when it encounters a CAPTCHA during PDF download (e.g., ScienceDirect).
    // PDF fetching is handled separately by schedulePdfFetchTask().
    const newItems = await translate.translate({
        libraryID: libraryId,
        saveAttachments: SAVE_ATTACHMENTS_WITH_TRANSLATORS
    });

    return newItems.length ? newItems[0] : null;
}

/**
 * Import an item from a URL using Zotero's RemoteTranslate and HiddenBrowser.
 * @param url - The URL to import the item from.
 * @param libraryId - Target library ID.
 * @returns A Promise that resolves to the imported Zotero.Item or null if the import fails.
 */
async function importFromUrl(url: string, libraryId: number): Promise<Zotero.Item | null> {
    if (!url) return null;

    // Dynamic import for Zotero modules
    // const { RemoteTranslate } = ChromeUtils.import_("chrome://zotero/content/RemoteTranslate.jsm");
    // const { HiddenBrowser } = ChromeUtils.import_("chrome://zotero/content/HiddenBrowser.jsm");
    const { RemoteTranslate } = ChromeUtils.importESModule("chrome://zotero/content/RemoteTranslate.mjs");
    const { HiddenBrowser } = ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs");

    const browser = new HiddenBrowser();
    const translate = new RemoteTranslate();
    
    try {
        logger(`importFromUrl: Attempting import from URL: ${url}`, 2);
        await browser.load(url);
        await translate.setBrowser(browser);
        
        const translators = await translate.detect();
        if (!translators || translators.length === 0) return null;

        // saveAttachments: false to prevent Zotero from opening a visible browser
        // window when it encounters a CAPTCHA during PDF download.
        // PDF fetching is handled separately by schedulePdfFetchTask().
        const newItems = await translate.translate({
            libraryID: libraryId,
            saveAttachments: SAVE_ATTACHMENTS_WITH_TRANSLATORS
        });

        return newItems && newItems.length ? newItems[0] : null;
    } catch (e) {
        logger(`importFromUrl: URL import failed: ${e}`, 1);
        return null;
    } finally {
        browser.destroy();
    }
}


/**
 * Helper to attach a PDF from a URL to an existing item.
 * @returns true if attachment was successful, false otherwise
 */
async function attachPdfFromUrl(parentItem: Zotero.Item, url: string, libraryId: number): Promise<boolean> {
    try {
        await Zotero.Attachments.importFromURL({
            libraryID: libraryId,
            url: url,
            parentItemID: parentItem.id,
            title: "Full Text PDF",
            contentType: "application/pdf",
            saveOptions: {
                skipSelect: true // Don't select the new attachment in the UI
            }
        });
        return true;
    } catch (e) {
        logger(`Failed to attach PDF from ${url}: ${e}`, 1);
        return false;
    }
}

/**
 * ATTEMPT 2: Manual Creation
 * Manually maps ExternalReference fields to a new Zotero Item.
 */
async function createItemManually(itemData: ExternalReference, libraryId: number): Promise<Zotero.Item> {
    // 1. Determine Item Type
    let itemType = mapPublicationType(itemData.publication_types);
    
    // Validate item type existence, fallback to document if invalid
    const typeID = Zotero.ItemTypes.getID(itemType);
    if (!typeID || !Zotero.ItemTypes.getName(typeID)) {
        logger(`createItemManually: Invalid item type ${itemType}, falling back to document`, 1);
        itemType = 'document';
    }

    const item = new Zotero.Item(itemType as any);
    item.libraryID = libraryId;

    // 2. Set Core Fields
    if (itemData.title) item.setField('title', itemData.title);
    if (itemData.publication_date) {
        item.setField('date', itemData.publication_date);
    } else if (itemData.year) {
        item.setField('date', itemData.year.toString());
    }
    
    if (itemData.url && Zotero.ItemFields.isValidForType('url', item.itemTypeID)) {
        item.setField('url', itemData.url);
    }
    
    if (itemData.abstract && Zotero.ItemFields.isValidForType('abstractNote', item.itemTypeID)) {
        item.setField('abstractNote', itemData.abstract);
    }
    
    // Handle publication title from journal object or venue
    const pubTitle = itemData.journal?.name || itemData.venue;
    if (pubTitle) {
        if (itemType === 'journalArticle') {
            if (Zotero.ItemFields.isValidForType('publicationTitle', item.itemTypeID)) item.setField('publicationTitle', pubTitle);
        } else if (itemType === 'conferencePaper') {
            if (Zotero.ItemFields.isValidForType('proceedingsTitle', item.itemTypeID)) item.setField('proceedingsTitle', pubTitle);
        } else if (Zotero.ItemFields.isValidForType('publicationTitle', item.itemTypeID)) {
            item.setField('publicationTitle', pubTitle);
        }
    }
    
    // Handle additional journal metadata
    if (itemData.journal) {
        if (itemData.journal.volume && Zotero.ItemFields.isValidForType('volume', item.itemTypeID)) {
            item.setField('volume', itemData.journal.volume);
        }
        if (itemData.journal.issue && Zotero.ItemFields.isValidForType('issue', item.itemTypeID)) {
            item.setField('issue', itemData.journal.issue);
        }
        if (itemData.journal.pages && Zotero.ItemFields.isValidForType('pages', item.itemTypeID)) {
            item.setField('pages', itemData.journal.pages);
        }
    }
    
    // 3. Identifiers (stored in specific fields or 'extra')
    if (itemData.identifiers?.doi && Zotero.ItemFields.isValidForType('DOI', item.itemTypeID)) {
        item.setField('DOI', itemData.identifiers.doi);
    }
    if (itemData.identifiers?.isbn && Zotero.ItemFields.isValidForType('ISBN', item.itemTypeID)) {
        item.setField('ISBN', itemData.identifiers.isbn);
    }
    
    // 4. Handle Authors
    // Zotero expects: { firstName: "...", lastName: "...", creatorType: "..." }
    if (itemData.authors && itemData.authors.length > 0) {
        const creators = itemData.authors.map(authorName => {
            // Use Zotero's utility to parse "Last, First" or "First Last"
            return (Zotero.Utilities as any).cleanAuthor(authorName, "author");
        });
        item.setCreators(creators);
    }

    // 5. Save the Item
    await item.saveTx();

    // Note: PDF attachment is handled via background task in createZoteroItem (or applyCreateItemData).
    // This keeps item creation fast and non-blocking.

    return item;
}

/**
 * Wraps a promise with a timeout that rejects if the promise takes too long
 * Only use this for operations that are safe to timeout (e.g., non-item-creating operations)
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        )
    ]);
}

/**
 * Creates a Zotero item from a ExternalReference object.
 * Tries to use Zotero's built-in translation (via DOI/Identifiers) first.
 * Falls back to manual creation if translation fails.
 * After item creation, uses Zotero's "Find Full Text" logic to find PDFs.
 * 
 * Note: We don't use timeouts on import methods because Zotero's translation
 * system cannot be canceled. A timed-out import could still complete and create
 * a duplicate item after we've fallen back to manual creation.
 * 
 * @param reference - External reference data to import
 * @param options - Import options including target library and collection
 */
export async function createZoteroItem(reference: ExternalReference, options?: ImportItemOptions): Promise<Zotero.Item> {
    // Resolve target library and collection
    const { libraryId, collectionId } = await resolveImportTarget(options);
    
    let item: Zotero.Item | null = null;

    // 1. Try to import using identifiers (DOI, arXiv, ISBN, etc.)
    // No timeout here - let Zotero's translation complete or fail naturally
    // to avoid duplicate items if the translation completes after timeout
    if (reference.identifiers) {
        try {
            item = await tryImportFromIdentifiers(reference.identifiers, libraryId);
            if (item) {
                logger("createZoteroItem: Successfully imported item via identifiers", 2);
            }
        } catch (e: any) {
            logger(`createZoteroItem: Failed to import via identifier: ${e?.message || e}`, 1);
        }
    }

    // 2. Try URL Translation (Semantic Scholar / Article Page)
    // No timeout here for the same reason as above
    if (!item && reference.url) {
        try {
            item = await importFromUrl(reference.url, libraryId);
            if (item) {
                logger("createZoteroItem: Successfully imported item via URL", 2);
            }
        } catch (e: any) {
            logger(`createZoteroItem: Failed to import via URL: ${e?.message || e}`, 1);
        }
    }

    // 3. Fallback: Create item manually from available metadata
    if (!item) {
        logger("createZoteroItem: Falling back to manual item creation", 2);
        item = await createItemManually(reference, libraryId);
    }
    
    // 4. Add to collection if specified
    if (collectionId) {
        const collection = Zotero.Collections.get(collectionId);
        if (collection) {
            await Zotero.DB.executeTransaction(async () => {
                await collection.addItem(item!.id);
            });
            logger(`createZoteroItem: Added item to collection ${collection.name}`, 2);
        }
    }

    // 5. Schedule background PDF fetch (unless caller handles it separately)
    if (!options?.skipBackgroundPdfFetch) {
        // Check if item already has a PDF (may have been added by translation)
        const existingAttachments = await item.getAttachments();
        const existingPdfAttachments = await filterPdfAttachments(existingAttachments);
        
        if (existingPdfAttachments.length === 0 && !isPdfFetchInProgress(libraryId, item.key)) {
            schedulePdfFetchTask(libraryId, item.key, {
                openAccessUrl: reference.open_access_url,
                fallbackUrl: reference.url,
                fileAvailable: reference.is_open_access,
            });
        }
    }

    return item;
}

/**
 * Creates a Zotero item from CreateItemProposedData with full post-processing.
 * Handles extra fields, collections, tags, and schedules PDF fetching as background task.
 * 
 * Performance optimizations:
 * - Consolidates all field modifications into a single saveTx() call
 * - PDF fetching runs as a background task (non-blocking)
 * - Returns immediately after item creation with core fields
 * 
 * @param proposedData - The proposed item data from the agent
 * @param options - Import options including target library and collection
 */
export async function applyCreateItemData(
    proposedData: CreateItemProposedData, 
    options?: ImportItemOptions
): Promise<CreateItemResultData> {
    const itemData = proposedData.item;

    // Create or Import the item (handles library/collection resolution internally)
    // Skip background PDF fetch here - we'll schedule it below with more context
    const item = await createZoteroItem(itemData, { 
        ...options, 
        skipBackgroundPdfFetch: true 
    });
    const libraryId = item.libraryID;
    const itemKey = item.key;
    
    // Track if we need to save (consolidate all modifications)
    let needsSave = false;
    
    // Post-processing (Things that apply regardless of how item was created)
    
    // 1. Add Extra fields (Identifiers that aren't standard fields, Beaver Reason)
    const extraLines: string[] = [];
    const identifiers = itemData.identifiers;
    
    if (identifiers) {
        const currentExtra = item.getField('extra') as string || '';
        if (identifiers.arXivID && !currentExtra.includes(identifiers.arXivID)) {
            extraLines.push(`arXiv: ${identifiers.arXivID}`);
        }
        if (identifiers.pmid && !currentExtra.includes(identifiers.pmid)) {
            extraLines.push(`PMID: ${identifiers.pmid}`);
        }
        if (identifiers.pmcid && !currentExtra.includes(identifiers.pmcid)) {
            extraLines.push(`PMCID: ${identifiers.pmcid}`);
        }
    }

    if (proposedData.reason) {
        extraLines.push(`Beaver Reason: ${proposedData.reason}`);
    }

    if (extraLines.length > 0) {
        const currentExtra = item.getField('extra') as string;
        item.setField('extra', currentExtra ? `${currentExtra}\n${extraLines.join('\n')}` : extraLines.join('\n'));
        needsSave = true;
    }

    // 2. Collections (from proposed data, in addition to context collection)
    if (proposedData.collection_keys && proposedData.collection_keys.length > 0) {
        const collectionIds: number[] = [];
        for (const key of proposedData.collection_keys) {
            const collection = Zotero.Collections.getByLibraryAndKey(libraryId, key);
            if (collection) collectionIds.push(collection.id);
        }
        if (collectionIds.length > 0) {
            // Append to existing collections if any (from translation or context)
            const currentCollections = item.getCollections();
            const newCollections = [...new Set([...currentCollections, ...collectionIds])];
            item.setCollections(newCollections);
            needsSave = true;
        }
    }
    
    // 3. Tags
    if (proposedData.suggested_tags && proposedData.suggested_tags.length > 0) {
        for (const tag of proposedData.suggested_tags) {
            item.addTag(tag);
        }
        needsSave = true;
    }

    // Single consolidated save for all modifications
    if (needsSave) {
        await item.saveTx();
        logger(`applyCreateItemData: Saved item with extra fields, collections, and tags`, 2);
    }

    // Check for existing PDF attachments (may have been added by translation)
    const existingAttachments = await item.getAttachments();
    const existingPdfAttachments = await filterPdfAttachments(existingAttachments);
    const attachmentKeys = existingPdfAttachments.length > 0 
        ? existingPdfAttachments.map(a => a.key).join(',') 
        : '';
    
    // Schedule PDF fetching as background task (non-blocking)
    // Only if no PDF exists and we have potential sources
    if (existingPdfAttachments.length === 0 && !isPdfFetchInProgress(libraryId, itemKey)) {
        const pdfUrl = itemData.open_access_url || proposedData.downloaded_url;
        
        // Schedule background PDF fetch
        schedulePdfFetchTask(libraryId, itemKey, {
            openAccessUrl: pdfUrl,
            fallbackUrl: itemData.url,
            fileAvailable: proposedData.file_available,
        });
    }

    return {
        library_id: libraryId,
        zotero_key: itemKey,
        attachment_keys: attachmentKeys
    };
}

/**
 * Filter attachment IDs to return only PDF attachments.
 */
async function filterPdfAttachments(attachmentIds: number[]): Promise<Zotero.Item[]> {
    if (!attachmentIds || attachmentIds.length === 0) return [];
    
    const attachments = await Promise.all(
        attachmentIds.map(id => Zotero.Items.getAsync(id))
    );
    
    return attachments.filter((a): a is Zotero.Item => 
        a && !a.deleted && a.isPDFAttachment()
    );
}

/** Options for PDF fetch background task */
interface PdfFetchOptions {
    openAccessUrl?: string;
    fallbackUrl?: string;
    fileAvailable?: boolean;
}

/**
 * Schedule a background task to fetch and attach PDF for an item.
 * Uses multiple strategies: direct URL, Zotero's addAvailableFile (Unpaywall, etc.)
 */
function schedulePdfFetchTask(
    libraryId: number, 
    itemKey: string, 
    options: PdfFetchOptions
): void {
    const taskId = generateTaskId('pdf_fetch', libraryId, itemKey);
    
    scheduleBackgroundTask(
        taskId,
        'pdf_fetch',
        async (signal: AbortSignal) => {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, itemKey);
            if (!item) {
                throw new Error(`Item not found: ${libraryId}-${itemKey}`);
            }

            // Check if cancelled or PDF was attached in the meantime
            if (signal.aborted) return;
            const attachmentIds = await item.getAttachments();
            const pdfAttachments = await filterPdfAttachments(attachmentIds);
            if (pdfAttachments.length > 0) {
                logger(`schedulePdfFetchTask: Item already has PDF, skipping`, 2);
                return;
            }

            let pdfAttached = false;

            // Strategy 1: Try open access URL if available
            // The presence of an openAccessUrl is sufficient evidence that a PDF may be available,
            // so we try it regardless of the fileAvailable flag
            if (!signal.aborted && options.openAccessUrl) {
                logger(`schedulePdfFetchTask: Trying open access URL: ${options.openAccessUrl}`, 2);
                pdfAttached = await attachPdfFromUrl(item, options.openAccessUrl, libraryId);
                if (pdfAttached) {
                    logger(`schedulePdfFetchTask: Successfully attached PDF from open access URL`, 2);
                }
            }

            // Strategy 2: Try fallback URL if different from open access URL
            // This is a less reliable source (general article URL), so only try when fileAvailable hints a PDF exists
            if (!signal.aborted && !pdfAttached && options.fallbackUrl && options.fileAvailable) {
                // Only try if different from openAccessUrl (avoid duplicate attempts)
                if (options.fallbackUrl !== options.openAccessUrl) {
                    logger(`schedulePdfFetchTask: Trying fallback URL: ${options.fallbackUrl}`, 2);
                    pdfAttached = await attachPdfFromUrl(item, options.fallbackUrl, libraryId);
                    if (pdfAttached) {
                        logger(`schedulePdfFetchTask: Successfully attached PDF from fallback URL`, 2);
                    }
                }
            }

            // Strategy 3: Use Zotero's addAvailableFile (Unpaywall, DOI lookup, etc.)
            if (!signal.aborted && !pdfAttached) {
                try {
                    logger(`schedulePdfFetchTask: Trying addAvailableFile for ${itemKey}`, 2);
                    const attachment = await withTimeout(
                        (Zotero.Attachments as any).addAvailableFile(item),
                        30000,
                        'Find PDF'
                    );
                    if (attachment) {
                        logger(`schedulePdfFetchTask: Found PDF via addAvailableFile`, 2);
                        pdfAttached = true;
                    }
                } catch (e: any) {
                    logger(`schedulePdfFetchTask: addAvailableFile failed: ${e?.message || e}`, 2);
                }
            }

            if (signal.aborted) return;

            if (pdfAttached) {
                // Sync the item to ensure the new attachment is sent to backend
                // This is important because the initial sync may have run before PDF was attached
                // Uses deduplication to avoid concurrent syncs for the same item
                try {
                    logger(`schedulePdfFetchTask: Syncing item after PDF attachment`, 2);
                    await deduplicatedSync(
                        libraryId,
                        itemKey,
                        async () => { await ensureItemSynced(libraryId, itemKey); },
                        { queueIfInFlight: true }
                    );
                } catch (e: any) {
                    logger(`schedulePdfFetchTask: Post-PDF sync failed: ${e?.message || e}`, 1);
                    // Don't throw - the PDF was attached successfully, sync failure is non-fatal
                }
            } else {
                logger(`schedulePdfFetchTask: No PDF found for ${itemKey}`, 2);
            }
        },
        {
            itemKey,
            libraryId,
            progressMessage: 'Finding PDF...',
        }
    );
}

/**
 * @deprecated Use applyCreateItemData instead
 */
export async function applyCreateItem(action: CreateItemProposedAction): Promise<CreateItemResultData> {
    return applyCreateItemData(action.proposed_data);
}

export async function deleteAddedItem(action: CreateItemProposedAction): Promise<void> {
    if (!action.result_data?.zotero_key) {
        throw new Error('Item key missing for deletion');
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        action.result_data.library_id,
        action.result_data.zotero_key
    );

    if (item) {
        // Erase the item
        await item.eraseTx();
    }
}
