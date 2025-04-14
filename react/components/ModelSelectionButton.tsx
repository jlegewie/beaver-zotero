import React from 'react';
// @ts-ignore no types for react
import { useState, useEffect, useMemo, useCallback } from 'react';
import MenuButton from './MenuButton';
import { MenuItem } from './ContextMenu';
import { BrainIcon, ArrowDownIcon, Icon } from './icons';
import { getPref, setPref } from '../../src/utils/prefs';
import { chatService, Model } from '../../src/services/chatService';
import { DEFAULT_MODEL } from './InputArea';

const MAX_MODEL_NAME_LENGTH = 17;
const REFETCH_INTERVAL_HOURS = 6;
const REFETCH_INTERVAL_MS = REFETCH_INTERVAL_HOURS * 60 * 60 * 1000;

interface ModelSelectionButtonProps {
    className?: string;
    selectedModel: Model;
    setSelectedModel: (model: Model) => void;
    supportedModels: Model[];
    setSupportedModels: (models: Model[]) => void;
}

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC<ModelSelectionButtonProps> = ({
    className = '',
    selectedModel,
    setSelectedModel,
    supportedModels,
    setSupportedModels,
}) => {
    const [availableModels, setAvailableModels] = useState<Model[]>([]);
    const [apiKeyStatus, setApiKeyStatus] = useState({
        google: false,
        openai: false,
        anthropic: false,
    });
    const [isLoading, setIsLoading] = useState(supportedModels.length === 0);
    const [isMounted, setIsMounted] = useState(false);

    const fetchModels = useCallback(async () => {
        if (!isMounted) return [];
        console.log("Fetching model list...");
        try {
            const models = await chatService.getModelList();
            if (isMounted) {
                setSupportedModels(models);
                setPref('supportedModels', JSON.stringify(models));
                setPref('supportedModelsLastFetched', Date.now().toString());
            }
            return models;
        } catch (error) {
            console.error("Failed to fetch model list:", error);
            if (isMounted) setSupportedModels([]);
            return [];
        }
    }, [isMounted, setSupportedModels]);

    useEffect(() => {
        setIsMounted(true);
        
        const loadData = async () => {
            const googleKey = getPref('googleGenerativeAiApiKey');
            const openaiKey = getPref('openAiApiKey');
            const anthropicKey = getPref('anthropicApiKey');
            const currentApiKeyStatus = {
                google: !!googleKey,
                openai: !!openaiKey,
                anthropic: !!anthropicKey,
            };
            setApiKeyStatus(currentApiKeyStatus);

            let cachedModels: Model[] = [];
            const cachedModelsPref = getPref('supportedModels');
            const lastFetchedPref = getPref('supportedModelsLastFetched');
            const lastFetchedTime = lastFetchedPref ? parseInt(lastFetchedPref, 10) : 0;
            const timeSinceLastFetch = Date.now() - lastFetchedTime;

            try {
                if (cachedModelsPref) {
                    cachedModels = JSON.parse(cachedModelsPref);
                    if (!Array.isArray(cachedModels)) cachedModels = [];
                }
            } catch (e) {
                console.error("Error parsing cached supportedModels:", e);
                cachedModels = [];
            }
            
            setSupportedModels(cachedModels); // Set initially from cache
            filterAndSetAvailableModels(cachedModels, currentApiKeyStatus); // Filter initially

            const hasAnyKey = currentApiKeyStatus.google || currentApiKeyStatus.openai || currentApiKeyStatus.anthropic;
            const shouldFetch = hasAnyKey && (cachedModels.length === 0 || timeSinceLastFetch > REFETCH_INTERVAL_MS);
            
            if (shouldFetch) {
                console.log("Fetching models because list is empty or outdated.");
                setIsLoading(true);
                const fetchedModels = await fetchModels();
                // Refetch API keys status in case they changed while fetching
                const latestKeys = {
                    google: !!getPref('googleGenerativeAiApiKey'),
                    openai: !!getPref('openAiApiKey'),
                    anthropic: !!getPref('anthropicApiKey'),
                };
                setApiKeyStatus(latestKeys);
                filterAndSetAvailableModels(fetchedModels, latestKeys);
                setIsLoading(false);
            } else {
                console.log("Using cached models.");
                setIsLoading(false); // Already loaded from cache or no keys
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

            // Ensure selectedModel is still available, otherwise reset to default
            const isSelectedModelAvailable = filtered.some(m => m.model_id === selectedModel.model_id) || selectedModel.model_id === DEFAULT_MODEL.model_id;
            if (!isSelectedModelAvailable && filtered.length > 0) {
                setSelectedModel(filtered[0]);
                setPref('lastUsedModel', JSON.stringify(filtered[0]));
            } else if (!isSelectedModelAvailable && filtered.length === 0) {
                setSelectedModel(DEFAULT_MODEL);
                setPref('lastUsedModel', JSON.stringify(DEFAULT_MODEL));
            }
        };

        loadData();

        return () => {
            setIsMounted(false);
        };
    }, [fetchModels, selectedModel, setSelectedModel]);

    const menuItems = useMemo((): MenuItem[] => {
        const items: MenuItem[] = [];

        items.push({
            label: 'Included Models',
            isGroupHeader: true,
            onClick: () => {},
        });

        items.push({
            label: `${DEFAULT_MODEL.name}`,
            onClick: () => {
                setSelectedModel(DEFAULT_MODEL);
                setPref('lastUsedModel', JSON.stringify(DEFAULT_MODEL));
            },
            customContent: (
                <span className={`flex-1 text-sm truncate ${selectedModel.model_id === DEFAULT_MODEL.model_id ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                    {DEFAULT_MODEL.name} {/* <span className="font-color-tertiary">(Default)</span> */}
                </span>
            )
        });

        items.push({
            label: 'Your API Keys',
            isGroupHeader: true,
            onClick: () => {},
        });

        // if (availableModels.length > 0) {
        //     items.push({ isDivider: true, label: '', onClick: () => {} });
        // }

        availableModels.forEach((model: Model) => {
            items.push({
                label: model.name,
                onClick: () => {
                    setSelectedModel(model);
                    setPref('lastUsedModel', JSON.stringify(model));
                },
                icon: model.reasoning_model ? BrainIcon : undefined,
                customContent: (
                    <span className="flex items-center gap-2 min-w-0">
                        <span className={`flex text-sm truncate ${selectedModel === model ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                            {model.name}
                        </span>
                        {model.reasoning_model
                            ? <Icon icon={BrainIcon} className={`-ml-015 ${selectedModel === model ? 'font-medium font-color-primary' : 'font-color-secondary'}`} />
                            : undefined
                        }
                    </span>
                )
            });
        });

        return items;
    }, [availableModels, setSelectedModel, selectedModel]);

    const hasAnyKey = apiKeyStatus.google || apiKeyStatus.openai || apiKeyStatus.anthropic;
    const isButtonDisabled = !hasAnyKey;

    const getButtonLabel = () => {
        return selectedModel.name.length > MAX_MODEL_NAME_LENGTH
            ? `${selectedModel.name.slice(0, (MAX_MODEL_NAME_LENGTH - 2))}...`
            : selectedModel.name;
    };

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost-secondary"
            buttonLabel={getButtonLabel()}
            icon={ selectedModel.reasoning_model ? BrainIcon : undefined }
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