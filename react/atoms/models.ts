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
 * Default model used when no models are available or when a previously
 * selected model becomes unavailable. This serves as a fallback option.
 */
export const DEFAULT_MODEL: FullModelConfig = {
    id: "6c750f70-8c2a-4e5b-9f1d-2a3b4c5d6e7f",
    provider: 'google',
    name: 'Gemini 2.0 Flash',
    snapshot: 'gemini/gemini-2.0-flash-001',
    is_agent: false,
    reasoning_model: false,
    use_app_key: true,
    credit_cost: 1,
    is_default: true,
} as FullModelConfig;

/**
 * Core atoms for model state management
 */
// Stores all models supported by the backend
export const supportedModelsAtom = atom<FullModelConfig[]>([]);

// Stores the currently selected model
export const selectedModelAtom = atom<FullModelConfig>(DEFAULT_MODEL);

/**
 * Derived atom that indicates if the selected model has agent capabilities
 */
export const isAgentModelAtom = atom((get) => get(selectedModelAtom).is_agent);

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
 * Initialization atom that loads models and selected model from preferences
 * This is called when the application starts up and:
 * 1. Loads cached models from preferences
 * 2. Finds the default model from the cached list
 * 3. Loads the last used model if it's still available
 * 4. Falls back to the default model if needed
 */
export const initModelsAtom = atom(
    null,
    async (get, set) => {
        // Load supportedModels from prefs
        let cachedModels: FullModelConfig[] = [];
        try {
            const cachedModelsPref = getPref('supportedModels');
            if (cachedModelsPref) {
                cachedModels = JSON.parse(cachedModelsPref as string);
                if (!Array.isArray(cachedModels)) cachedModels = [];
            }
        } catch (e) {
            console.error("Error parsing cached supportedModels:", e);
            cachedModels = [];
        }
        
        // Find default model in cache if available
        const defaultModel = cachedModels.find(model => model.is_default) || DEFAULT_MODEL;
        
        // Set supported models
        set(supportedModelsAtom, cachedModels);
        
        // Load selected model from prefs or use default
        try {
            const lastUsedModelPref = getPref('lastUsedModel');
            if (lastUsedModelPref) {
                const lastUsedModel = JSON.parse(lastUsedModelPref as string);
                
                // Only set if it's in the available models or it's the default model
                const availableModels = get(availableModelsAtom);
                const isModelAvailable = 
                lastUsedModel.id === defaultModel.id || 
                availableModels.some(m => m.id === lastUsedModel.id);
                
                if (isModelAvailable) {
                    set(selectedModelAtom, lastUsedModel);
                } else {
                    set(selectedModelAtom, defaultModel);
                }
            } else {
                set(selectedModelAtom, defaultModel);
            }
        } catch (e) {
            console.error("Error parsing lastUsedModel:", e);
            set(selectedModelAtom, defaultModel);
        }
    }
);

/**
 * Validation atom that ensures the selected model is still available
 * This is called when API keys change to verify the selected model is valid:
 * - If current model is invalid, switches to an available model
 * - If no models are available, falls back to DEFAULT_MODEL
 */
export const validateSelectedModelAtom = atom(
    null,
    (get, set) => {
        const selectedModel = get(selectedModelAtom);
        const availableModels = get(availableModelsAtom);
        const defaultModel = availableModels.find(model => model.is_default) || DEFAULT_MODEL;

        // Check if the selected model is still valid with current API keys
        const isModelAvailable = 
            selectedModel.id === defaultModel.id || 
            availableModels.some(m => m.id === selectedModel.id);

        // If not valid, revert to default or first available model
        if (!isModelAvailable) {
            if (availableModels.length > 0) {
                set(selectedModelAtom, availableModels[0]);
                setPref('lastUsedModel', JSON.stringify(availableModels[0]));
            } else {
                set(selectedModelAtom, defaultModel);
                setPref('lastUsedModel', JSON.stringify(defaultModel));
            }
        }
    }
);

/**
 * API fetch atom that retrieves models from the backend
 * This updates the list of supported models and ensures the
 * selected model is still valid after the update
 */
export const fetchModelsAtom = atom(
    null,
    async (get, set) => {
        logger("Fetching model list...");
        try {
            const plan_id = get(planIdAtom);
            if (!plan_id) {
                logger("No plan ID found, skipping model fetch");
                return;
            }
            // Fetch models and set supported models
            const models = await accountService.getModelList(plan_id);
            set(supportedModelsAtom, models);
            setPref('supportedModels', JSON.stringify(models));
            setPref('supportedModelsLastFetched', Date.now().toString());
            
            // Ensure selected model is still available
            const availableModels = get(availableModelsAtom);
            const selectedModel = get(selectedModelAtom);
            const defaultModel = models.find(model => model.is_default) || DEFAULT_MODEL;
            
            const isSelectedModelAvailable = 
                selectedModel.id === defaultModel.id || 
                availableModels.some(m => m.id === selectedModel.id);
            
            if (!isSelectedModelAvailable && availableModels.length > 0) {
                set(selectedModelAtom, availableModels[0]);
                setPref('lastUsedModel', JSON.stringify(availableModels[0]));
            } else if (!isSelectedModelAvailable) {
                set(selectedModelAtom, defaultModel);
                setPref('lastUsedModel', JSON.stringify(defaultModel));
            }
        } catch (error) {
            console.error("Failed to fetch model list:", error);
        }
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