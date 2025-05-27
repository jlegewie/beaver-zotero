import { ContentPart } from '../../src/services/OpenAIProvider';


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