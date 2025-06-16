import { atom } from 'jotai';
import { accountService } from '../../src/services/accountService';
import { getPref, setPref } from '../../src/utils/prefs';
import { logger } from '../../src/utils/logger';
import { planIdAtom } from './profile';

/**
 * Supported AI model provider types
 */
export type ProviderType = "anthropic" | "google" | "openai" | "mistralai" | "meta-llama" | "deepseek-ai" | "groq";
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/**
 * ModelConfig interface representing an AI model for chat completion
 * @property id - Unique identifier for the model
 * @property provider - The provider of the model (anthropic, google, openai)
 * @property snapshot - The provider's model identifier used in API calls
 * @property is_agent - Whether the model supports agent capabilities
 * @property reasoning_model - Whether the model provides reasoning capabilities
 * @property kwargs - Additional provider-specific parameters
 * @property price_input_tokens - The cost of input tokens
 * @property price_output_tokens - The cost of output tokens
 * @property cache_discount - The discount for cached responses
 */
export interface ModelConfig {
    id: string;
    provider: ProviderType;
    name: string;
    snapshot: string;
    is_agent: boolean;
    reasoning_model?: boolean;
    reasoning_effort?: ReasoningEffort;
    kwargs?: Record<string, any>;
    price_input_tokens?: number;
    price_output_tokens?: number;
    cache_discount?: number;
}

export interface FullModelConfig extends ModelConfig {
    use_app_key: boolean;
    credit_cost: number;
    is_default: boolean;
}

/**
 * Core atoms for model state management
 */

// Stores all models supported by the backend
export const supportedModelsAtom = atom<FullModelConfig[]>([]);

// Stores the currently selected model
let lastUsedModel = null;
try {
    lastUsedModel = JSON.parse(getPref('lastUsedModel')) as FullModelConfig;
} catch (error) {
    lastUsedModel = null
}
export const selectedModelAtom = atom<FullModelConfig | null>(lastUsedModel);

/**
 * Derived atom that indicates if the selected model has agent capabilities
 */
export const isAgentModelAtom = atom((get) => get(selectedModelAtom)?.is_agent || false);

/**
 * Derived atom that filters supported models based on available API keys
 * Models are available if they:
 * 1. Use the app's API key (app_key: true), or
 * 2. Have a matching user-provided API key for their provider
 */
export const availableModelsAtom = atom(
    get => {
        const supportedModels = get(supportedModelsAtom);
        const apiKeys = {
            google: !!getPref('googleGenerativeAiApiKey'),
            openai: !!getPref('openAiApiKey'),
            anthropic: !!getPref('anthropicApiKey')
        };
        
        return supportedModels.filter(model => {
            if (model.use_app_key) return true;
            if (!model.use_app_key && model.provider === 'google' && apiKeys.google) return true;
            if (!model.use_app_key && model.provider === 'openai' && apiKeys.openai) return true;
            if (!model.use_app_key && model.provider === 'anthropic' && apiKeys.anthropic) return true;
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
    (get, set, models: FullModelConfig[]) => {
        // Update supported models
        set(supportedModelsAtom, models);

        // Validate and update selected model if needed
        set(validateSelectedModelAtom);
    }
);


// Atom to update selected model
export const updateSelectedModelAtom = atom(
    null,
    (_, set, model: FullModelConfig) => {
        set(selectedModelAtom, model);
        setPref('lastUsedModel', JSON.stringify(model));
    }
);