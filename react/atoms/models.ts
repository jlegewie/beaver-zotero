import { atom } from 'jotai';
import { chatService } from '../../src/services/chatService';
import { getPref, setPref } from '../../src/utils/prefs';
import { logger } from '../../src/utils/logger';

// Add this interface to the existing interfaces
export type ProviderType = "anthropic" | "google" | "openai";
export interface Model {
    id: string;
    provider: ProviderType;
    name: string;
    model_id: string;
    is_agent: boolean;
    reasoning_model?: boolean;
    kwargs?: Record<string, any>;
    app_key: boolean;
    default?: boolean;
}

// DEFAULT MODEL
export const DEFAULT_MODEL: Model = {
    id: "6c750f70",
    provider: 'google',
    name: 'Gemini 2.0 Flash',
    model_id: 'gemini/gemini-2.0-flash-001',
    is_agent: false,
    reasoning_model: false,
    app_key: true,
    default: true
} as Model;

/**
* Models and selection state
*/
export const supportedModelsAtom = atom<Model[]>([]);
export const selectedModelAtom = atom<Model>(DEFAULT_MODEL);

// Derived atom to get if the selected model is an agent model
export const isAgentModelAtom = atom((get) => get(selectedModelAtom).is_agent);

// Derived atom to get available models based on API keys
export const availableModelsAtom = atom(
    get => {
        const supportedModels = get(supportedModelsAtom);
        const apiKeys = {
            google: !!getPref('googleGenerativeAiApiKey'),
            openai: !!getPref('openAiApiKey'),
            anthropic: !!getPref('anthropicApiKey')
        };
        
        return supportedModels.filter(model => {
            if (model.app_key) return true;
            if (!model.app_key && model.provider === 'google' && apiKeys.google) return true;
            if (!model.app_key && model.provider === 'openai' && apiKeys.openai) return true;
            if (!model.app_key && model.provider === 'anthropic' && apiKeys.anthropic) return true;
            return false;
        });
    }
);

// Initialization atom to load models and selected model from preferences
export const initModelsAtom = atom(
    null,
    async (get, set) => {
        // Load supportedModels from prefs
        let cachedModels: Model[] = [];
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
        const defaultModel = cachedModels.find(model => model.default) || DEFAULT_MODEL;
        
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

// Validate selected model
export const validateSelectedModelAtom = atom(
    null,
    (get, set) => {
        const selectedModel = get(selectedModelAtom);
        const availableModels = get(availableModelsAtom);

        // Check if the selected model is still valid with current API keys
        const isModelAvailable = 
            selectedModel.model_id === DEFAULT_MODEL.model_id || 
            availableModels.some(m => m.model_id === selectedModel.model_id);

        // If not valid, revert to default or first available model
        if (!isModelAvailable) {
            if (availableModels.length > 0) {
                set(selectedModelAtom, availableModels[0]);
                setPref('lastUsedModel', JSON.stringify(availableModels[0]));
            } else {
                set(selectedModelAtom, DEFAULT_MODEL);
                setPref('lastUsedModel', JSON.stringify(DEFAULT_MODEL));
            }
        }
    }
);

// Atom to update models from API
export const fetchModelsAtom = atom(
    null,
    async (get, set) => {
        logger("Fetching model list...");
        try {
            // Fetch models and set supported models
            const models = await chatService.getModelList();
            set(supportedModelsAtom, models);
            setPref('supportedModels', JSON.stringify(models));
            setPref('supportedModelsLastFetched', Date.now().toString());
            
            // Ensure selected model is still available
            const availableModels = get(availableModelsAtom);
            const selectedModel = get(selectedModelAtom);
            const isSelectedModelAvailable = 
                selectedModel.id === DEFAULT_MODEL.id || 
                availableModels.some(m => m.id === selectedModel.id);
            
            if (!isSelectedModelAvailable && availableModels.length > 0) {
                set(selectedModelAtom, availableModels[0]);
                setPref('lastUsedModel', JSON.stringify(availableModels[0]));
            } else if (!isSelectedModelAvailable) {
                set(selectedModelAtom, DEFAULT_MODEL);
                setPref('lastUsedModel', JSON.stringify(DEFAULT_MODEL));
            }
        } catch (error) {
            console.error("Failed to fetch model list:", error);
        }
    }
);

// Atom to update selected model
export const updateSelectedModelAtom = atom(
    null,
    (_, set, model: Model) => {
        set(selectedModelAtom, model);
        setPref('lastUsedModel', JSON.stringify(model));
    }
);