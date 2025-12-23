import { atom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { getCustomChatModelsFromPreferences, CustomChatModel, ModelProvider } from '../types/settings';
import { logger } from '../../src/utils/logger';

const CUSTOM_MODEL_ID_PREFIX = 'custom';

export type ProviderType = ModelProvider;
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Access mode determines how the model is accessed
 * - app_key: Use the app's API key (included in plan, uses credits)
 * - byok: Use the user's own API key (bring your own key)
 * - custom: Custom model with user's own configuration
 */
export type AccessMode = "app_key" | "byok" | "custom";

export interface ModelPricing {
    input: number;
    output: number;
    cache_write?: number;
    cache_read?: number;
}

/**
 * ModelConfig interface representing an AI model for chat completion
 * Matches the backend ModelConfig model from model_configs table.
 */
export interface ModelConfig {
    /** UUID from backend model_configs table (or synthetic ID for custom models) */
    id: string;
    provider: ProviderType;
    name: string;
    /** The provider's model identifier used in API calls */
    snapshot: string;
    pricing?: ModelPricing;
    is_enabled?: boolean;

    // Access and billing configuration
    is_default: boolean;
    credit_cost: number;
    /** Whether users can use their own API key with this model */
    allow_byok: boolean;
    /** Whether this model is available via the app's API key */
    allow_app_key: boolean;
    /** Whether this model supports usage-based billing */
    allow_usage_billing?: boolean;
    
    // Model capabilities
    reasoning_model?: boolean;
    reasoning_effort?: ReasoningEffort;
    context_window?: number;
    supports_vision?: boolean;

    // Frontend-only fields for custom models
    is_custom?: boolean;
    custom_model?: CustomChatModel;

    // Frontend-only field to track selected access mode
    // Only set when user explicitly selects a model from UI
    access_mode?: AccessMode;
}

const createCustomModelId = (model: CustomChatModel): string => {
    return [
        CUSTOM_MODEL_ID_PREFIX,
        model.provider,
        encodeURIComponent(model.snapshot),
        encodeURIComponent(model.name)
    ].join(':');
};

const mapCustomModelsToConfigs = (): ModelConfig[] => {
    const customModels = getCustomChatModelsFromPreferences();

    return customModels.map((model) => {
        const id = createCustomModelId(model);

        return {
            id,
            provider: model.provider as ProviderType,
            name: model.name,
            snapshot: model.snapshot,
            context_window: model.context_window,
            reasoning_model: false,
            pricing: {
                input: 0,
                output: 0,
            },
            credit_cost: 0,
            is_default: false,
            allow_byok: true,
            allow_app_key: false,
            is_custom: true,
            custom_model: model,
            access_mode: 'custom',
        };
    });
};

const initialCustomModels = mapCustomModelsToConfigs();

const withCustomModels = (models: ModelConfig[]): ModelConfig[] => {
    const customModels = mapCustomModelsToConfigs();
    const merged = new Map<string, ModelConfig>();

    [...models, ...customModels].forEach((model) => {
        merged.set(model.id, model);
    });

    return Array.from(merged.values());
};

/**
 * Core atoms for model state management
 */

// Stores all models supported by the backend
const googleApiKeyAtom = atom(getPref('googleGenerativeAiApiKey') ?? '');
const openAiApiKeyAtom = atom(getPref('openAiApiKey') ?? '');
const anthropicApiKeyAtom = atom(getPref('anthropicApiKey') ?? '');

export const supportedModelsAtom = atom<ModelConfig[]>(initialCustomModels);

// Stores the currently selected model
let lastUsedModel = null;
try {
    const stored = JSON.parse(getPref('lastUsedModel')) as ModelConfig;
    if (stored?.is_custom) {
        lastUsedModel = initialCustomModels.find(model => model.id === stored.id) || stored;
    } else {
        lastUsedModel = stored;
    }
} catch (error) {
    lastUsedModel = null
}
export const selectedModelAtom = atom<ModelConfig | null>(lastUsedModel);

/**
 * Derived atom that indicates if the selected model uses the app's API key
 */
export const isAppKeyModelAtom = atom((get) => get(selectedModelAtom)?.allow_app_key || false);

/**
 * Derived atom that filters supported models based on available API keys
 * Models are available if they:
 * 1. Are custom models (always available)
 * 2. Use the app's API key (allow_app_key: true), or
 * 3. Allow BYOK and have a matching user-provided API key for their provider
 */
export const availableModelsAtom = atom(
    get => {
        const supportedModels = get(supportedModelsAtom);
        const apiKeys = {
            google: !!get(googleApiKeyAtom),
            openai: !!get(openAiApiKeyAtom),
            anthropic: !!get(anthropicApiKeyAtom)
        };
        
        return supportedModels.filter(model => {
            if (model.is_custom) return true;
            if (model.allow_app_key) return true;
            // BYOK models: available if user has an API key for the provider
            if (model.allow_byok && model.provider === 'google' && apiKeys.google) return true;
            if (model.allow_byok && model.provider === 'openai' && apiKeys.openai) return true;
            if (model.allow_byok && model.provider === 'anthropic' && apiKeys.anthropic) return true;
            return false;
        });
    }
);

/**
 * Validation atom that ensures the selected model is still available
 * If current model is invalid, switches to default model or first available model
 */
export const validateSelectedModelAtom = atom(
    null,
    (get, set) => {
        const selectedModel = get(selectedModelAtom);
        const availableModels = get(availableModelsAtom);
        
        // Default model
        let defaultModel = availableModels.find(model => model.is_default) || null;
        if (!defaultModel && availableModels.length > 0) defaultModel = availableModels[0];
        // Add access_mode to default model if it allows app_key
        if (defaultModel && defaultModel.allow_app_key && !defaultModel.access_mode) {
            defaultModel = { ...defaultModel, access_mode: 'app_key' as AccessMode };
        }

        // Check if the selected model is still valid with current API keys
        const isModelAvailable = selectedModel && availableModels.some(m => m.id === selectedModel.id);

        // If not valid, revert to default or first available model
        if (!isModelAvailable) {
            set(selectedModelAtom, defaultModel);
            if(defaultModel) setPref('lastUsedModel', JSON.stringify(defaultModel));
        }
    }
);

/**
 * Setter atom that updates supported models and validates selected model
 * This handles all atom updates when new models are provided:
 * 1. Updates supportedModelsAtom with new models
 * 2. Validates and updates selected model if needed
 */
export const setModelsAtom = atom(
    null,
    (_get, set, models: ModelConfig[]) => {
        // Update supported models
        set(supportedModelsAtom, withCustomModels(models));

        // Validate and update selected model if needed
        set(validateSelectedModelAtom);
    }
);


// Atom to update selected model
export const updateSelectedModelAtom = atom(
    null,
    (_, set, model: ModelConfig) => {
        set(selectedModelAtom, model);
        setPref('lastUsedModel', JSON.stringify(model));
    }
);

export const setApiKeyAtom = atom(
    null,
    (_, set, { provider, value }: { provider: ProviderType; value: string }) => {
        switch (provider) {
            case 'google':
                set(googleApiKeyAtom, value ?? '');
                break;
            case 'openai':
                set(openAiApiKeyAtom, value ?? '');
                break;
            case 'anthropic':
                set(anthropicApiKeyAtom, value ?? '');
                break;
            default:
                logger(`Unsupported provider passed to setApiKeyAtom: ${provider}`, 1);
                break;
        }
    }
);
