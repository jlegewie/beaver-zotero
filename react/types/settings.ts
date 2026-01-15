import { getPref } from "../../src/utils/prefs";
import { store } from "../store";
import { addPopupMessageAtom } from "../utils/popupMessageUtils";
import { ProcessingMode } from "./profile";

export type ModelProvider = "anthropic" | "google" | "openai" | "mistralai" | "meta-llama" | "deepseek-ai" | "groq";

// Session flag to prevent repeated popup warnings
let hasShownCustomModelsParsingWarning = false;

/**
 * Configuration for custom models.
 * 
 * Either:
 * - provider="openrouter" to use OpenRouter's API, OR
 * - api_base with format to use a custom OpenAI/Anthropic-compatible endpoint
 * 
 * When api_base is provided, provider defaults to "custom" for logging purposes.
 */
export interface CustomChatModel {
    provider?: string;  // defaults to "custom"
    api_base?: string;
    format?: 'openai' | 'anthropic';
    api_key: string;
    name: string;
    snapshot: string;
    context_window?: number;
    reasoning_effort?: 'low' | 'medium' | 'high';
    supports_vision?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

export const isCustomChatModel = (obj: unknown): obj is CustomChatModel => {
    if (!isObject(obj)) return false;

    const { 
        provider, 
        api_base, 
        format, 
        api_key, 
        name, 
        snapshot, 
        context_window,
        reasoning_effort,
        supports_vision
    } = obj as Record<string, unknown>;

    // Required fields
    if (typeof api_key !== 'string' || api_key.trim().length === 0) return false;
    if (typeof name !== 'string' || name.trim().length === 0) return false;
    if (typeof snapshot !== 'string' || snapshot.trim().length === 0) return false;

    // Either provider is 'openrouter' or api_base must be provided
    const normalizedProvider = typeof provider === 'string' ? provider.toLowerCase() : 'custom';
    if (normalizedProvider === 'custom' && !api_base) return false;

    // Optional field validations
    if (provider !== undefined && typeof provider !== 'string') return false;
    if (api_base !== undefined && typeof api_base !== 'string') return false;
    if (format !== undefined && format !== 'openai' && format !== 'anthropic') return false;
    if (context_window !== undefined && typeof context_window !== 'number') return false;
    if (reasoning_effort !== undefined && 
        reasoning_effort !== 'low' && 
        reasoning_effort !== 'medium' && 
        reasoning_effort !== 'high') return false;
    if (supports_vision !== undefined && typeof supports_vision !== 'boolean') return false;

    return true;
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
        
        // Show warning popup once per session
        if (!hasShownCustomModelsParsingWarning) {
            hasShownCustomModelsParsingWarning = true;
            store.set(addPopupMessageAtom, {
                type: 'warning',
                title: 'Custom Models Configuration Error',
                text: 'Failed to parse custom models configuration. Please check that beaver.customChatModels contains valid JSON.',
                expire: false,
                learnMoreUrl: 'https://www.beaverapp.ai/docs/custom-models',
                learnMoreLabel: 'Configuration Guide'
            });
        }
        return [];
    }
    return [];
};

export interface CustomPrompt {
    title: string;
    text: string;
    librarySearch: boolean;
    requiresAttachment: boolean;
    requiresDatabaseSync?: boolean;
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
        (obj.requiresDatabaseSync === undefined || typeof obj.requiresDatabaseSync === 'boolean') &&
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

export interface CustomPromptAvailabilityContext {
    isDatabaseSyncSupported: boolean;
    processingMode: ProcessingMode;
}

const isCustomPromptAvailable = (
    prompt: CustomPrompt,
    context: CustomPromptAvailabilityContext
): boolean => {
    if (prompt.requiresDatabaseSync && (!context.isDatabaseSyncSupported || context.processingMode === ProcessingMode.FRONTEND)) {
        return false;
    }
    return true;
};

export const getCustomPromptsForContext = (
    context: CustomPromptAvailabilityContext
): CustomPrompt[] => {
    const prompts = getCustomPromptsFromPreferences();
    return prompts
        .filter((prompt) => isCustomPromptAvailable(prompt, context))
        .map((prompt, index) => ({
            ...prompt,
            index: index + 1
        }));
};
