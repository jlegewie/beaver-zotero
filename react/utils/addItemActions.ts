import { AddItemProposedAction, AddItemResultData, ProposedItem, NormalizedPublicationType } from '../types/proposedActions/items';
import { logger } from '../../src/utils/logger';

// Helper to map publication types
function mapPublicationType(types: NormalizedPublicationType[] | undefined): string {
    if (!types || types.length === 0) return 'journalArticle';
    
    const type = types[0];
    switch (type) {
        case 'journal_article': return 'journalArticle';
        case 'conference_paper': return 'conferencePaper';
        case 'book': return 'book';
        case 'book_chapter': return 'bookSection';
        case 'preprint': return 'preprint';
        case 'review': return 'journalArticle';
        case 'dataset': return 'dataset';
        case 'thesis': return 'thesis';
        case 'report': return 'report';
        case 'editorial': return 'journalArticle';
        case 'other': return 'document';
        default: return 'journalArticle';
    }
}

/**
 * ATTEMPT 1: Use Zotero's Translation Architecture
 * This is preferred because it handles metadata fetching and PDF downloading automatically.
 */
async function tryImportFromIdentifiers(identifiers: any): Promise<Zotero.Item | null> {
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
    const newItems = await translate.translate({
        libraryID: Zotero.Libraries.userLibraryID,
        saveAttachments: true // Automatically download PDFs if available
    });

    return newItems.length ? newItems[0] : null;
}

/**
 * Helper to attach a PDF from a URL to an existing item
 */
async function attachPdfFromUrl(parentItem: Zotero.Item, url: string) {
    try {
        await Zotero.Attachments.importFromURL({
            libraryID: Zotero.Libraries.userLibraryID,
            url: url,
            parentItemID: parentItem.id,
            title: "Full Text PDF",
            contentType: "application/pdf",
            saveOptions: {
                skipSelect: true // Don't select the new attachment in the UI
            }
        });
    } catch (e) {
        logger(`Failed to attach PDF from ${url}: ${e}`, 1);
    }
}

/**
 * ATTEMPT 2: Manual Creation
 * Manually maps ProposedItem fields to a new Zotero Item.
 */
async function createItemManually(itemData: ProposedItem): Promise<Zotero.Item> {
    const libraryId = Zotero.Libraries.userLibraryID;

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
    
    if (itemData.url && (item as any).isValidField('url')) {
        item.setField('url', itemData.url);
    }
    
    if (itemData.abstract && (item as any).isValidField('abstractNote')) {
        item.setField('abstractNote', itemData.abstract);
    }
    
    if (itemData.publication_title || itemData.venue) {
        const pubTitle = itemData.publication_title || itemData.venue;
        if (pubTitle) {
            if (itemType === 'journalArticle') {
                 if ((item as any).isValidField('publicationTitle')) item.setField('publicationTitle', pubTitle);
            } else if (itemType === 'conferencePaper') {
                 if ((item as any).isValidField('proceedingsTitle')) item.setField('proceedingsTitle', pubTitle);
            } else if ((item as any).isValidField('publicationTitle')) {
                 item.setField('publicationTitle', pubTitle);
            }
        }
    }
    
    // 3. Identifiers (stored in specific fields or 'extra')
    if (itemData.identifiers?.doi && (item as any).isValidField('DOI')) {
        item.setField('DOI', itemData.identifiers.doi);
    }
    if (itemData.identifiers?.isbn && (item as any).isValidField('ISBN')) {
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

    // 5. Save the Item (Transaction)
    await Zotero.DB.executeTransaction(async () => {
        await item.saveTx();
    });

    // 6. Manual Attachment Handling
    // If we created the item manually, we need to attach the PDF manually if provided
    if (itemData.open_access_url) {
        await attachPdfFromUrl(item, itemData.open_access_url);
    }

    return item;
}

/**
 * Creates a Zotero item from a ProposedItem object.
 * Tries to use Zotero's built-in translation (via DOI/Identifiers) first.
 * Falls back to manual creation if translation fails.
 */
async function createZoteroItem(proposedItem: ProposedItem): Promise<Zotero.Item> {
    // 1. Try to import using identifiers (DOI, arXiv, ISBN, etc.)
    if (proposedItem.identifiers) {
        try {
            const translatedItem = await tryImportFromIdentifiers(proposedItem.identifiers);
            if (translatedItem) {
                logger("Successfully imported item via identifiers", 2);
                return translatedItem;
            }
        } catch (e) {
            logger(`Failed to import via identifier, falling back to manual creation: ${e}`, 1);
        }
    }

    // 2. Fallback: Create item manually from available metadata
    logger("Falling back to manual item creation", 2);
    return await createItemManually(proposedItem);
}

export async function applyAddItem(action: AddItemProposedAction): Promise<AddItemResultData> {
    const itemData = action.proposed_data.item;
    const libraryId = Zotero.Libraries.userLibraryID;

    // Create or Import the item
    const item = await createZoteroItem(itemData);
    
    // Post-processing (Things that apply regardless of how item was created)
    
    // Add Extra fields (Identifiers that aren't standard fields, Beaver Reason)
    const extraLines: string[] = [];
    const identifiers = itemData.identifiers;
    
    if (identifiers) {
        if (identifiers.arXivID && !item.getField('extra')?.includes(identifiers.arXivID)) {
             extraLines.push(`arXiv: ${identifiers.arXivID}`);
        }
        if (identifiers.pmid && !item.getField('extra')?.includes(identifiers.pmid)) {
            extraLines.push(`PMID: ${identifiers.pmid}`);
        }
        if (identifiers.pmcid && !item.getField('extra')?.includes(identifiers.pmcid)) {
            extraLines.push(`PMCID: ${identifiers.pmcid}`);
        }
    }

    if (action.proposed_data.reason) {
        extraLines.push(`Beaver Reason: ${action.proposed_data.reason}`);
    }

    if (extraLines.length > 0) {
        const currentExtra = item.getField('extra') as string;
        item.setField('extra', currentExtra ? `${currentExtra}\n${extraLines.join('\n')}` : extraLines.join('\n'));
        await item.saveTx();
    }

    // Collections
    if (action.proposed_data.collection_keys && action.proposed_data.collection_keys.length > 0) {
        const collectionIds: number[] = [];
        for (const key of action.proposed_data.collection_keys) {
             const collection = Zotero.Collections.getByLibraryAndKey(libraryId, key);
             if (collection) collectionIds.push(collection.id);
        }
        // Append to existing collections if any (from translation)
        const currentCollections = item.getCollections();
        const newCollections = [...new Set([...currentCollections, ...collectionIds])];
        item.setCollections(newCollections);
        await item.saveTx();
    }
    
    // Tags
    if (action.proposed_data.suggested_tags) {
        for (const tag of action.proposed_data.suggested_tags) {
            item.addTag(tag);
        }
        await item.saveTx();
    }

    // Attachments check
    // If item has no attachments, and we have a URL (either open access or general), try attaching.
    const attachments = await item.getAttachments();
    let attachmentKeys = '';
    
    if ((!attachments || attachments.length === 0) && action.proposed_data.file_available) {
         const url = itemData.open_access_url || action.proposed_data.downloaded_url || itemData.url;
         if (url) {
             logger(`applyAddItem: Attaching file from ${url} (post-creation)`, 2);
             await attachPdfFromUrl(item, url);
         }
    }
    
    // Refetch attachments to get key
    const finalAttachments = await item.getAttachments();
    if (finalAttachments && finalAttachments.length > 0) {
        const attachmentItem = await Zotero.Items.getAsync(finalAttachments[0]);
        if (attachmentItem) {
            attachmentKeys = attachmentItem.key;
        }
    }

    return {
        library_id: libraryId,
        zotero_key: item.key,
        attachment_keys: attachmentKeys
    };
}

export async function deleteAddedItem(action: AddItemProposedAction): Promise<void> {
    if (!action.result_data?.zotero_key) {
        throw new Error('Item key missing for deletion');
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        action.result_data.library_id,
        action.result_data.zotero_key
    );

    if (item) {
        await Zotero.DB.executeTransaction(async () => {
            await item.eraseTx();
        });
    }
}
