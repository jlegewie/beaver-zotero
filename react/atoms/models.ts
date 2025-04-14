import { atom } from 'jotai';
import { chatService } from '../../src/services/chatService';
import { getPref, setPref } from '../../src/utils/prefs';

// Add this interface to the existing interfaces
export type ProviderType = "anthropic" | "google" | "openai";
export interface Model {
    provider: ProviderType;
    name: string;
    model_id: string;
    reasoning_model?: boolean;
    kwargs?: Record<string, any>;
    app_key: boolean;
}

// DEFAULT MODEL
export const DEFAULT_MODEL: Model = {
    provider: 'google',
    name: 'Gemini 2.0 Flash',
    model_id: 'gemini-2.0-flash-001',
    reasoning_model: false,
    app_key: true
} as Model;

/**
* Models and selection state
*/
export const supportedModelsAtom = atom<Model[]>([]);
export const selectedModelAtom = atom<Model>(DEFAULT_MODEL);

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
            if (model.provider === 'google' && apiKeys.google) return true;
            if (model.provider === 'openai' && apiKeys.openai) return true;
            if (model.provider === 'anthropic' && apiKeys.anthropic) return true;
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
        
        // Set supported models
        set(supportedModelsAtom, cachedModels);
        
        // Load selected model from prefs
        try {
            const lastUsedModelPref = getPref('lastUsedModel');
            if (lastUsedModelPref) {
                const lastUsedModel = JSON.parse(lastUsedModelPref as string);
                
                // Only set if it's in the available models or it's the DEFAULT_MODEL
                const availableModels = get(availableModelsAtom);
                const isModelAvailable = 
                lastUsedModel.model_id === DEFAULT_MODEL.model_id || 
                availableModels.some(m => m.model_id === lastUsedModel.model_id);
                
                if (isModelAvailable) {
                    set(selectedModelAtom, lastUsedModel);
                }
            }
        } catch (e) {
            console.error("Error parsing lastUsedModel:", e);
        }
    }
);

// Atom to update models from API
export const fetchModelsAtom = atom(
    null,
    async (get, set) => {
        console.log("Fetching model list...");
        try {
            const models = await chatService.getModelList();
            set(supportedModelsAtom, models);
            setPref('supportedModels', JSON.stringify(models));
            setPref('supportedModelsLastFetched', Date.now().toString());
            
            // Ensure selected model is still available
            const availableModels = get(availableModelsAtom);
            const selectedModel = get(selectedModelAtom);
            const isSelectedModelAvailable = 
            selectedModel.model_id === DEFAULT_MODEL.model_id || 
            availableModels.some(m => m.model_id === selectedModel.model_id);
            
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
    (get, set, model: Model) => {
        set(selectedModelAtom, model);
        setPref('lastUsedModel', JSON.stringify(model));
    }
);