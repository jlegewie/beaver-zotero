import { Source } from '../types/sources';
import { ContentPart } from '../../src/services/OpenAIProvider';
import { getBibliography } from '../../src/utils/citations';
import { getZoteroItem } from './sourceUtils';


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

/**
 * Convert a Source to content parts
 * 
 * @param source - The source to convert
 * @returns Promise<ContentPart[]> - The content parts
 */
export async function sourceToContentParts(source: Source): Promise<ContentPart[]> {
    if (source.type === 'zotero_item') {
        // Get the Zotero item
        const item = getZoteroItem(source);

        // Skip if the item is not a regular item (regular items should already be flattened)
        if (!item || item.isRegularItem()) return [];

        // Define id and parent item
        const id = `${source.libraryID}-${source.itemKey}`;
        const parentItem = item.parentItem;

        // Attachment with parent item
        if (parentItem && item.isAttachment()) {
            /*const title = parentItem.getDisplayTitle();
            const authors = parentItem?.getCreators();
            const year = parentItem.getField('date', true).slice(0, 4);*/
            const type = Zotero.ItemTypes.getLocalizedString(parentItem.itemType);
            const reference = getBibliography(parentItem);
            const warning = `This document is an attachment and can be the ${type}, an Appendix, Supplement, a review, or other related material attached to the ${type}.`;
            const metadata = `# Document (id: ${id})\nType: ${type}\nReference: ${reference}`;

            // Get the file path
            const filePath = await item.getFilePath();
            if (!filePath) return [];

            // return content parts
            return [
                { type: 'text', text: metadata },
                await fileToContentPart(filePath)
            ]

        // Note with parent item
        } else if (parentItem && item.isNote()) {
            const type = Zotero.ItemTypes.getLocalizedString(parentItem.itemType);
            const reference = getBibliography(parentItem);
            // @ts-ignore unescapeHTML exists
            const content = Zotero.Utilities.unescapeHTML(item.getNote());
            const noteData = `# Note (id: ${id})\nType of parent: ${type}\nReference of parent: ${reference}\nNote Content: ${content}`;
            return [{ type: 'text', text: noteData }]
        // Top-level attachment
        } else if (!parentItem && item.isAttachment()) {
            // @ts-ignore getFilename exists
            const fileName = item.getFileName();
            const metadata = `# Document (id: ${id})\nFile Name: ${fileName}`;

            // Get the file path
            const filePath = await item.getFilePath();
            if (!filePath) return [];

            // return content parts
            return [
                { type: 'text', text: metadata },
                await fileToContentPart(filePath)
            ]
            
        // Top-level note
        } else if (!parentItem && item.isNote()) {
            // const content = await getNoteAsMarkdown(item);
            // @ts-ignore unescapeHTML exists
            const content = Zotero.Utilities.unescapeHTML(item.getNote());
            const noteData = `# Note (id: ${id})\nNote Content: ${content}`;
            return [{ type: 'text', text: noteData }]
        }
    }
    if (source.type === 'file') {
        const metadata = `# Document (id: ${source.id})\nFile Name: ${source.fileName}`;
        // Get the file path
        const filePath = source.filePath;
        if (!filePath) return [];

        // return content parts
        return [
            { type: 'text', text: metadata },
            await fileToContentPart(filePath)
        ];
    }
    if (source.type === 'remote_file') {
        return [urlToContentPart(source.url)];
    }
    return [];
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


/**
 * Example of formatted messages produced by sourceToContentParts
 * messages = [
 *     {"role": "system", "content": SYSTEM_PROMPT},
 *     // Example of a Zotero attachment with parent item (e.g., PDF)
 *     {
 *         "role": "user", 
 *         "content": [
 *             {
 *                 "type": "text",
 *                 "text": "# Document (id: 1-ABC123)\nType: journalArticle\nReference: Smith, J. (2023). Advances in AI. Journal of AI Research, 45(2), 123-145."
 *             },
 *             {
 *                 "type": "image_url",
 *                 "image_url": {"url": "data:application/pdf;base64,JVBERi0xLjcKJeLjz9..."}
 *             }
 *         ]
 *     },
 *     // Example of a Zotero note with parent item
 *     {
 *         "role": "user", 
 *         "content": [
 *             {
 *                 "type": "text",
 *                 "text": "# Note (id: 1-DEF456)\nType of parent: journalArticle\nReference of parent: Smith, J. (2023). Advances in AI. Journal of AI Research, 45(2), 123-145.\nNote Content: This paper discusses key advancements in generative AI models."
 *             },
 *         ]
 *     },
 *     // Example of a top-level attachment
 *     {
 *         "role": "user", 
 *         "content": [
 *             {
 *                 "type": "text",
 *                 "text": "# Document (id: 1-GHI789)\nFile Name: report.pdf"
 *             },
 *             {
 *                 "type": "image_url",
 *                 "image_url": {"url": "data:application/pdf;base64,JVBERi0xLjcKJeLjz9..."}
 *             },
 *         ]
 *     },
 *     // Example of a top-level note
 *     {
 *         "role": "user", 
 *         "content": [
 *             {
 *                 "type": "text",
 *                 "text": "# Note (id: 1-JKL012)\nNote Content: <p>These are my research notes for the AI project.</p>"
 *             },
 *         ]
 *     },
 *     // Example of a local file source
 *     {
 *         "role": "user", 
 *         "content": [
 *             {
 *                 "type": "text",
 *                 "text": "# Document (id: file-123)\nFile Name: analysis.png"
 *             },
 *             {
 *                 "type": "image_url",
 *                 "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."}
 *             },
*         ]
 *     },
 *     // The user's query
 *     {
 *         "role": "user", 
 *         "content": [
 *             {
 *                 "type": "text",
 *                 "text": "# User Query\nCan you summarize the key findings from Smith's paper on AI advancements?"
 *             }
 *         ]
 *     }
 * ]
 */