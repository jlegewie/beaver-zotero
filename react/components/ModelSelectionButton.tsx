import React from 'react';
// @ts-ignore no types for react
import { useState, useEffect, useMemo, useCallback } from 'react';
import MenuButton from './MenuButton';
import { MenuItem } from './ContextMenu';
import { BrainIcon, ArrowDownIcon } from './icons';
import { getPref, setPref } from '../../src/utils/prefs';
import { chatService, Model } from '../../src/services/chatService';

const DEFAULT_MODEL_ID = "gemini-2.0-flash-001";
const DEFAULT_MODEL_NAME = "Gemini 2.0 Flash";

interface ModelSelectionButtonProps {
    className?: string;
    selectedModel: string;
    setSelectedModel: (modelId: string) => void;
}

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC<ModelSelectionButtonProps> = ({
    className = '',
    selectedModel,
    setSelectedModel,
}) => {
    const [supportedModels, setSupportedModels] = useState<Model[]>([]);
    const [availableModels, setAvailableModels] = useState<Model[]>([]);
    const [apiKeyStatus, setApiKeyStatus] = useState({
        google: false,
        openai: false,
        anthropic: false,
    });
    const [isLoading, setIsLoading] = useState(true);
    const [isMounted, setIsMounted] = useState(false);

    const fetchModelsDebounced = useCallback(async () => {
        if (!isMounted) return [];
        console.log("Fetching model list...");
        try {
            const models = await chatService.getModelList();
            if (isMounted) {
                setSupportedModels(models);
                setPref('supportedModels', JSON.stringify(models));
                console.log("Models fetched and stored:", models);
            }
            return models;
        } catch (error) {
            console.error("Failed to fetch model list:", error);
            if (isMounted) setSupportedModels([]);
            return [];
        }
    }, [isMounted]);

    useEffect(() => {
        setIsMounted(true);
        let debounceTimeout: number | undefined;

        const loadData = async () => {
            setIsLoading(true);

            const googleKey = getPref('googleGenerativeAiApiKey');
            const openaiKey = getPref('openAiApiKey');
            const anthropicKey = getPref('anthropicApiKey');
            const currentApiKeyStatus = {
                google: !!googleKey,
                openai: !!openaiKey,
                anthropic: !!anthropicKey,
            };
            setApiKeyStatus(currentApiKeyStatus);

            let models: Model[] = [];
            const cachedModelsPref = getPref('supportedModels');
            try {
                if (cachedModelsPref) {
                    models = JSON.parse(cachedModelsPref);
                    if (!Array.isArray(models)) models = [];
                }
            } catch (e) {
                console.error("Error parsing cached supportedModels:", e);
                models = [];
            }

            setSupportedModels(models);
            filterAndSetAvailableModels(models, currentApiKeyStatus);

            const hasAnyKey = currentApiKeyStatus.google || currentApiKeyStatus.openai || currentApiKeyStatus.anthropic;
            if (hasAnyKey) {
                clearTimeout(debounceTimeout);
                debounceTimeout = Zotero.getMainWindow().setTimeout(async () => {
                    const fetchedModels = await fetchModelsDebounced();
                    setApiKeyStatus(prevKeys => {
                        const latestKeys = {
                            google: !!getPref('googleGenerativeAiApiKey'),
                            openai: !!getPref('openAiApiKey'),
                            anthropic: !!getPref('anthropicApiKey'),
                        };
                        filterAndSetAvailableModels(fetchedModels, latestKeys);
                        return latestKeys;
                    });
                    setIsLoading(false);
                }, 1000);
            } else {
                setIsLoading(false);
            }
        };

        const filterAndSetAvailableModels = (allModels: Model[], keys: typeof apiKeyStatus) => {
            const filtered = allModels.filter(model => {
                if (model.provider === 'google' && keys.google) return true;
                if (model.provider === 'openai' && keys.openai) return true;
                if (model.provider === 'anthropic' && keys.anthropic) return true;
                return false;
            });
            setAvailableModels(filtered);
        };

        loadData();

        return () => {
            setIsMounted(false);
            clearTimeout(debounceTimeout);
        };
    }, [fetchModelsDebounced]);

    const menuItems = useMemo((): MenuItem[] => {
        const items: MenuItem[] = [];

        items.push({
            label: `${DEFAULT_MODEL_NAME}`,
            onClick: () => {
                setSelectedModel(DEFAULT_MODEL_ID);
                setPref('lastUsedModel', DEFAULT_MODEL_ID);
            },
            customContent: (
                <span className={`flex-1 text-sm truncate ${selectedModel === DEFAULT_MODEL_ID ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                    {DEFAULT_MODEL_NAME} {/* <span className="font-color-tertiary">(Default)</span> */}
                </span>
            )
        });

        // if (availableModels.length > 0) {
        //     items.push({ isDivider: true, label: '', onClick: () => {} });
        // }

        availableModels.forEach((model: Model) => {
            items.push({
                label: model.name,
                onClick: () => {
                    setSelectedModel(model.model_id);
                    setPref('lastUsedModel', model.model_id);
                },
                icon: model.reasoning_model ? BrainIcon : undefined,
                customContent: (
                    <span className="flex items-start gap-2 w-full min-w-0">
                        <span className={`flex-1 text-sm truncate ${selectedModel === model.model_id ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                            {model.name}
                        </span>
                    </span>
                )
            });
        });

        return items;
    }, [availableModels, setSelectedModel, selectedModel]);

    const hasAnyKey = apiKeyStatus.google || apiKeyStatus.openai || apiKeyStatus.anthropic;
    const isButtonDisabled = !hasAnyKey;

    const getButtonLabel = () => {
        if (selectedModel === DEFAULT_MODEL_ID) {
            return `${DEFAULT_MODEL_NAME}`;
        }
        const allPossibleModels = [
            { name: DEFAULT_MODEL_NAME, model_id: DEFAULT_MODEL_ID, provider: 'google' as const },
            ...supportedModels
        ];
        const model = allPossibleModels.find(m => m.model_id === selectedModel);
        return model ? model.name : 'Select Model';
    };

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost-secondary"
            buttonLabel={getButtonLabel()}
            icon={ BrainIcon }
            rightIcon={ArrowDownIcon}
            className={`${className} truncate`}
            style={{padding: '2px 0px', fontSize: '0.80rem', maxWidth: '120px'}}
            iconClassName="scale-11 -mr-015"
            rightIconClassName="scale-11 -ml-1"
            ariaLabel="Select AI Model"
            tooltipContent={isButtonDisabled ? 'Add your own API keys to select a model' : 'Choose AI model'}
            showArrow={false}
            disabled={isLoading || isButtonDisabled}
            // width="fit-content"
        />
    );
};

export default ModelSelectionButton; 