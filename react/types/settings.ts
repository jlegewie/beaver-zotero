import { getPref, setPref } from "../../src/utils/prefs";
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
 */
export const getCustomChatModelsForEditing = (): CustomChatModel[] => {
    try {
        const raw = getPref('customChatModels');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw as string);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(isObject).map((entry) => {
                const e = entry as Record<string, unknown>;
                return {
                    api_base: typeof e.api_base === 'string' ? e.api_base : '',
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

export interface ApiBaseValidationResult {
    valid: boolean;
    error?: string;
}

/** Returns true when the host is a private, loopback, or link-local address. */
const isPrivateOrReservedHost = (host: string): boolean => {
    // IPv6 loopback / link-local / unique-local
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
        return true;
    }
    // IPv4 dotted-quad ranges
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const a = parseInt(ipv4[1], 10);
        const b = parseInt(ipv4[2], 10);
        if (a === 10) return true;                        // 10.0.0.0/8
        if (a === 127) return true;                       // loopback
        if (a === 0) return true;                         // 0.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true;          // 192.168.0.0/16
        if (a === 169 && b === 254) return true;          // link-local / cloud metadata
    }
    return false;
};

/**
 * Mirror of the backend SSRF protection for custom endpoints. Beaver routes
 * every request through its own backend, so custom endpoints must be reachable
 * from the public internet over HTTPS — localhost, private networks, and reserved
 * IP ranges are rejected. Keeping this check client-side gives users an immediate
 * error before a request is attempted.
 */
export const validateCustomProviderApiBase = (apiBase: string | undefined): ApiBaseValidationResult => {
    const value = (apiBase ?? '').trim();
    if (!value) {
        return { valid: false, error: 'An endpoint URL is required for custom providers.' };
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { valid: false, error: 'Enter a valid URL, for example https://api.example.com/v1.' };
    }
    if (url.protocol !== 'https:') {
        return { valid: false, error: 'The endpoint must use HTTPS. Plain HTTP endpoints are blocked.' };
    }
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === 'localhost.localdomain') {
        return { valid: false, error: 'The endpoint cannot point to localhost. It must be reachable from the public internet.' };
    }
    if (isPrivateOrReservedHost(host)) {
        return { valid: false, error: 'The endpoint cannot use a private, internal, or reserved IP address. It must be reachable from the public internet.' };
    }
    return { valid: true };
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
