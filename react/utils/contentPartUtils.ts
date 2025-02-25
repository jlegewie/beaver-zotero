import { ZoteroResource, FileResource, RemoteFileResource, Resource } from '../types/resources';
import { fileToContentPart, urlToContentPart, ContentPart } from '../../src/services/OpenAIProvider';
import { getFormattedReferences } from '../../src/utils/citations';
import { getChildItems, getZoteroItem } from './resourceUtils';


// Utility function to get note content as markdown
async function getNoteAsMarkdown(item: Zotero.Item) {
    const translation = new Zotero.Translate.Export();
    translation.setItems([item]);
    translation.setTranslator(Zotero.Translators.TRANSLATOR_ID_NOTE_MARKDOWN);
    let markdown = '';
    translation.setHandler("done", (obj: any, worked: boolean) => {
        if (worked) {
            markdown = obj.string.replace(/\r\n/g, '\n');
        }
    });
    await translation.translate();
    return markdown;
}

// Get content part from a Zotero note
async function getContentPartFromZoteroNote(item: Zotero.Item): Promise<ContentPart[]> {
    // @ts-ignore unescapeHTML exists
    const content = Zotero.Utilities.unescapeHTML(item.getNote());
    const title = item.getNoteTitle();
    
    return [{
        type: 'text',
        text: `id: ${item.key}\ntype: Note\nname: ${title}\n\n${content}`
    }];
}

// Get content part from a Zotero item, with name for citation
async function getContentPartFromZoteroItem(item: Zotero.Item, name: string): Promise<ContentPart[]> {
    if (item.isNote()) {
        return await getContentPartFromZoteroNote(item);
    }
    
    if (item.isAttachment()) {
        const filePath = item ? await item.getFilePath() : undefined;
        if (filePath) {
            return [
                {
                    type: 'text',
                    text: `id: ${item.key}\ntype: Document\nReference: ${name}`
                },
                await fileToContentPart(filePath)
            ];
        }
    }
    
    return [];
}

// Convert a ZoteroResource to content parts
export async function resourceToContentParts(resource: Resource): Promise<ContentPart[]> {
    switch (resource.type) {
        case 'zotero_item': {
            // Get the Zotero item
            const item = getZoteroItem(resource);
            if (!item) return [];
            
            // Get name for reference
            const metadata = getFormattedReferences([item])[0];
            
            // If the resource has defined child items, get the content of the child items
            // if (resource.childItemKeys && resource.childItemKeys.length > 0) {
            if (item.isRegularItem()) {
                const childItems = getChildItems(resource);
                
                const childItemsContent = await Promise.all(
                    childItems.filter(Boolean).map(item => 
                        getContentPartFromZoteroItem(item, metadata.bibliography)
                    )
                );
                
                return childItemsContent.flat();
            }
            
            return await getContentPartFromZoteroItem(item, metadata.bibliography);
        }
        
        case 'file': {
            if (resource.filePath) {
                return [await fileToContentPart(resource.filePath)];
            }
            return [];
        }
        
        case 'remote_file': {
            return [urlToContentPart(resource.url)];
        }
        
        default:
        return [];
    }
}