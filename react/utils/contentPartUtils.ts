import { Resource } from '../types/resources';
import { ContentPart } from '../../src/services/OpenAIProvider';
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


/**
 * Utility function to convert a file (image/pdf) to base64 string encoding
 * 
 * @param filePath - Path to the file to convert
 * @returns Promise<string> - Base64 encoded string of the file contents
 * @throws Error if file cannot be read or converted
 */
export async function fileToBase64(filePath: string): Promise<string> {
    try {
        // Get the file's content type
        const file = Zotero.File.pathToFile(filePath);
        const contentType = await Zotero.MIME.getMIMETypeFromFile(file);
        
        // Generate data URI which includes base64 encoding
        const dataUri = await Zotero.File.generateDataURI(filePath, contentType);
        
        // Extract just the base64 part by removing the Data URI prefix
        // Data URIs are formatted as: data:[<mediatype>][;base64],<data>
        const base64Data = dataUri.split(',')[1];
        
        return base64Data;
    }
    catch (e: any) {
        throw new Error(`Failed to convert file to base64: ${e.message}`);
    }
}

/**
 * Utility function to convert a file (image/pdf) to a data URL
 * 
 * @param filePath - Path to the file to convert
 * @returns Promise<string> - Data URL of the file contents
 */
export async function fileToDataURL(filePath: string): Promise<string> {
    const file = Zotero.File.pathToFile(filePath);
    const contentType = await Zotero.MIME.getMIMETypeFromFile(file);
    const base64 = await fileToBase64(filePath);
    return `data:${contentType};base64,${base64}`;
}

/**
 * Utility function to convert a file to a content part
 * 
 * @param filePath - Path to the file to convert
 * @returns Promise<ContentPart> - Content part of the file
 */
export async function fileToContentPart(filePath: string): Promise<ContentPart> {
    return {
        type: 'image_url',
        image_url: { url: await fileToDataURL(filePath)}
    } as ContentPart;
}

export function urlToContentPart(url: string): ContentPart {
    return { type: 'image_url', image_url: { url: url } } as ContentPart;
}

/**
 * Example of a message with an image
 * messages = [
 *     {"role": "system", "content": system_message},
 *     {
 *         "role": "user", 
 *         "content": [
 *             {
 *                 "type": "image_url",
 *                 "image_url": {"url": f"data:image/png;base64,{image_base64}"}
 *             },
 *             {"role": "user", "content": "This is my image"}
 *         ]
 *     },
 *     {"role": "user", "content": "test"},
 * ]
 */