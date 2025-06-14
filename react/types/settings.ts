import { getPref } from "../../src/utils/prefs";

export interface CustomPrompt {
    title: string;
    text: string;
    librarySearch: boolean;
    requiresAttachment: boolean;
    id_model?: string;
    index?: number;
}

export const isCustomPrompt = (obj: any): obj is CustomPrompt => {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.title === 'string' &&
        typeof obj.text === 'string' &&
        typeof obj.librarySearch === 'boolean' &&
        typeof obj.requiresAttachment === 'boolean' &&
        (obj.id_model === undefined || typeof obj.id_model === 'string')
    );
}

export const getCustomPromptsFromPreferences = (): CustomPrompt[] => {

    try {
        const raw = getPref('customPrompts');
        if (raw && typeof raw === 'string') {
            const customPrompts = JSON.parse(raw as string);
            if(!Array.isArray(customPrompts)) throw new Error("customPrompts preference must be an array");
            return customPrompts
                .filter(isCustomPrompt)
                .map((prompt, index) => ({
                    ...prompt,
                    index: index + 1,
                } as CustomPrompt));
        }
    } catch (e) {
        console.error("Error parsing customPrompts:", e);
        return [];
    }
    return [];
}