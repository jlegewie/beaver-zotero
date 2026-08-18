import { getPref, setPref } from "../../src/utils/prefs";
import { store } from "../store";
import { addPopupMessageAtom } from "../utils/popupMessageUtils";
import { ProcessingMode } from "@beaver/agent-core/types/profile";
import { CustomChatModel, isCustomChatModel, OPENROUTER_API_BASE } from "@beaver/agent-core/types/customChatModel";

export * from "@beaver/agent-core/types/customChatModel";

// Session flag to prevent repeated popup warnings
let hasShownCustomModelsParsingWarning = false;

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

/**
 * Backfill a missing endpoint for custom entries so legacy configs that predate
 * the endpoint field default to OpenRouter (the same default new providers use)
 * instead of being dropped as invalid. Entries that already set `api_base`, or
 * that route through the native `provider: "openrouter"` path, are left untouched.
 */
const withDefaultEndpoint = (entry: unknown): unknown => {
    if (!isObject(entry)) return entry;
    const provider = typeof entry.provider === 'string' ? entry.provider.toLowerCase() : 'custom';
    const apiBase = typeof entry.api_base === 'string' ? entry.api_base.trim() : '';
    if (!apiBase && provider === 'custom') {
        return { ...entry, api_base: OPENROUTER_API_BASE };
    }
    return entry;
};

export const getCustomChatModelsFromPreferences = (): CustomChatModel[] => {
    try {
        const raw = getPref('customChatModels');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw as string);
            if (!Array.isArray(parsed)) throw new Error("customChatModels preference must be an array");
            return parsed.map(withDefaultEndpoint).filter(isCustomChatModel);
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
                learnMoreUrl: `${process.env.WEBAPP_BASE_URL}/docs/custom-models`,
                learnMoreLabel: 'Configuration Guide'
            });
        }
        return [];
    }
    return [];
};

/**
 * Read custom models for the preferences editor.
 *
 * Unlike {@link getCustomChatModelsFromPreferences}, this does NOT drop entries
 * that fail full validation. A provider that is still being filled in (missing
 * api_key, api_base, etc.) must survive a preferences reopen, so the editor reads
 * the raw array and only coerces it into a predictable shape. The model selector
 * keeps using the stricter getter so incomplete providers never appear as usable
 * models.
 *
 * Entries without an explicit endpoint default to OpenRouter, matching how new
 * providers are seeded ({@link OPENROUTER_API_BASE}). This migrates legacy
 * configs — both `provider: "openrouter"` entries that never stored an endpoint
 * and OpenRouter-key entries that predate the endpoint field — so the editor
 * treats them as complete custom providers instead of flagging them incomplete.
 */
export const getCustomChatModelsForEditing = (): CustomChatModel[] => {
    try {
        const raw = getPref('customChatModels');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw as string);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(isObject).map((entry) => {
                const e = entry as Record<string, unknown>;
                let api_base = typeof e.api_base === 'string' ? e.api_base : '';
                // An empty endpoint defaults to OpenRouter (the most common custom
                // setup) so legacy entries validate as complete custom providers.
                if (!api_base.trim()) {
                    api_base = OPENROUTER_API_BASE;
                }
                return {
                    api_base,
                    format: e.format === 'anthropic' ? 'anthropic' : 'openai',
                    api_key: typeof e.api_key === 'string' ? e.api_key : '',
                    name: typeof e.name === 'string' ? e.name : '',
                    snapshot: typeof e.snapshot === 'string' ? e.snapshot : '',
                    context_window: typeof e.context_window === 'number' ? e.context_window : undefined,
                    supports_vision: typeof e.supports_vision === 'boolean' ? e.supports_vision : false,
                } as CustomChatModel;
            });
        }
    } catch (e) {
        console.error("Error parsing customChatModels:", e);
    }
    return [];
};

/**
 * Persist the custom models array. Only the known custom-model fields are written
 * so transient editor state (React keys, etc.) never leaks into the preference.
 * The `provider` field is intentionally omitted: custom endpoints always default
 * to "custom" on the backend.
 */
export const saveCustomChatModelsToPreferences = (models: CustomChatModel[]): void => {
    const cleaned = models.map((model) => {
        const entry: CustomChatModel = {
            api_base: model.api_base?.trim() || undefined,
            format: model.format === 'anthropic' ? 'anthropic' : 'openai',
            api_key: model.api_key?.trim() ?? '',
            name: model.name?.trim() ?? '',
            snapshot: model.snapshot?.trim() ?? '',
            supports_vision: model.supports_vision ?? false,
        };
        if (typeof model.context_window === 'number' && Number.isFinite(model.context_window)) {
            entry.context_window = model.context_window;
        }
        return entry;
    });
    setPref('customChatModels', JSON.stringify(cleaned));
};

export interface CustomPrompt {
    id?: string;
    title: string;
    text: string;
    requiresAttachment: boolean;
    requiresDatabaseSync?: boolean;
    id_model?: string;
    shortcut?: number;
    index?: number;
    lastUsed?: string;
}

/** Generate a stable unique identifier for a custom prompt. */
export const generatePromptId = (): string => crypto.randomUUID();

export const isCustomPrompt = (obj: any): obj is CustomPrompt => {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof obj.title === 'string' &&
        typeof obj.text === 'string' &&
        typeof obj.requiresAttachment === 'boolean' &&
        (obj.requiresDatabaseSync === undefined || typeof obj.requiresDatabaseSync === 'boolean') &&
        (obj.id === undefined || typeof obj.id === 'string') &&
        (obj.id_model === undefined || typeof obj.id_model === 'string') &&
        (obj.shortcut === undefined || (typeof obj.shortcut === 'number' && obj.shortcut >= 1 && obj.shortcut <= 9)) &&
        (obj.lastUsed === undefined || typeof obj.lastUsed === 'string')
    );
};

/** Current storage format version for custom prompts. */
const CUSTOM_PROMPTS_VERSION = 2;

export const getCustomPromptsFromPreferences = (): CustomPrompt[] => {
    try {
        const raw = getPref('customPrompts');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw as string);

            let prompts: any[];
            let isLegacy: boolean;

            if (Array.isArray(parsed)) {
                // Legacy format: bare array (version 1)
                prompts = parsed;
                isLegacy = true;
            } else if (
                typeof parsed === 'object' && parsed !== null &&
                parsed.version >= CUSTOM_PROMPTS_VERSION && Array.isArray(parsed.prompts)
            ) {
                // Current versioned format
                prompts = parsed.prompts;
                isLegacy = false;
            } else {
                throw new Error("customPrompts preference has unrecognized format");
            }

            const validated = prompts.filter(isCustomPrompt);

            // Ensure every prompt has a stable unique id
            const ensureId = (prompt: CustomPrompt): CustomPrompt => ({
                ...prompt,
                id: prompt.id || generatePromptId(),
            });

            // Merge lastUsed timestamps from separate preference
            const lastUsedMap = getPromptLastUsedMap();
            const mergeLastUsed = (prompt: CustomPrompt): CustomPrompt => {
                const id = prompt.id;
                if (id && lastUsedMap[id]) {
                    return { ...prompt, lastUsed: lastUsedMap[id] };
                }
                return prompt;
            };

            // Legacy migration: auto-assign shortcuts 1-9 based on position
            if (isLegacy) {
                return validated.map((prompt, index) => mergeLastUsed(ensureId({
                    ...prompt,
                    ...(index < 9 ? { shortcut: index + 1 } : {}),
                    index: index + 1,
                })));
            }

            return validated.map((prompt, index) => mergeLastUsed(ensureId({
                ...prompt,
                index: index + 1,
            })));
        }
    } catch (e) {
        console.error("Error parsing customPrompts:", e);
        return [];
    }
    return [];
};

/** Save custom prompts in the versioned format. Strips `index` and `lastUsed` (both derived/stored elsewhere). */
export const saveCustomPromptsToPreferences = (prompts: CustomPrompt[]): void => {
    const promptsToSave = prompts.map(({ index, lastUsed, ...prompt }) => prompt);
    const data = { version: CUSTOM_PROMPTS_VERSION, prompts: promptsToSave };
    setPref('customPrompts', JSON.stringify(data));
};

// =============================================================================
// Separate lastUsed storage – keeps the main customPrompts pref clean so
// developer-shipped defaults can still propagate to users who haven't edited.
// =============================================================================

type PromptLastUsedMap = Record<string, string>;

/** Read the { [promptId]: isoTimestamp } map from its own preference. */
export const getPromptLastUsedMap = (): PromptLastUsedMap => {
    try {
        const raw = getPref('customPromptsLastUsed');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed as PromptLastUsedMap;
            }
        }
    } catch (e) {
        console.error('Error parsing customPromptsLastUsed:', e);
    }
    return {};
};

/** Persist a single prompt's lastUsed timestamp (merges into existing map). */
export const savePromptLastUsed = (id: string, timestamp: string): void => {
    const map = getPromptLastUsedMap();
    map[id] = timestamp;
    setPref('customPromptsLastUsed', JSON.stringify(map));
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
            index: index + 1,
        }));
};
