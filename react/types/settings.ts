import { getPref } from "../../src/utils/prefs";

export type ModelProvider = "anthropic" | "google" | "openai" | "mistralai" | "meta-llama" | "deepseek-ai" | "groq";

export interface CustomChatModel {
    provider: string;
    api_key: string;
    name: string;
    snapshot: string;
    api_base?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

export const isCustomChatModel = (obj: unknown): obj is CustomChatModel => {
    if (!isObject(obj)) return false;

    const { provider, api_key, name, snapshot } = obj as Record<string, unknown>;

    return (
        typeof provider === 'string' &&
        provider.length > 0 &&
        typeof api_key === 'string' &&
        api_key.length > 0 &&
        typeof name === 'string' &&
        name.length > 0 &&
        typeof snapshot === 'string' &&
        snapshot.length > 0
    );
};

export const getCustomChatModelsFromPreferences = (): CustomChatModel[] => {
    try {
        const raw = getPref('customChatModels');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw as string);
            if (!Array.isArray(parsed)) throw new Error("customChatModels preference must be an array");
            return parsed.filter(isCustomChatModel);
        }
    } catch (e) {
        console.error("Error parsing customChatModels:", e);
        return [];
    }
    return [];
};

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
};

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
};
