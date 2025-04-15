import React from 'react';
// @ts-ignore no types for react
import { useState, useEffect, useMemo } from 'react';
import MenuButton from './MenuButton';
import { MenuItem } from './ContextMenu';
import { BrainIcon, ArrowDownIcon, Icon } from './icons';
import { getPref } from '../../src/utils/prefs';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { 
  selectedModelAtom, 
  DEFAULT_MODEL, 
  supportedModelsAtom, 
  availableModelsAtom,
  initModelsAtom,
  fetchModelsAtom, 
  updateSelectedModelAtom,
  validateSelectedModelAtom
} from '../atoms/models';

const MAX_MODEL_NAME_LENGTH = 17;
const REFETCH_INTERVAL_HOURS = 6;
const REFETCH_INTERVAL_MS = REFETCH_INTERVAL_HOURS * 60 * 60 * 1000;

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC = () => {
    const [isLoading, setIsLoading] = useState(true);
    const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
    const supportedModels = useAtomValue(supportedModelsAtom);
    const availableModels = useAtomValue(availableModelsAtom);
    const initModels = useAtom(initModelsAtom)[1];
    const fetchModels = useAtom(fetchModelsAtom)[1];
    const updateSelectedModel = useSetAtom(updateSelectedModelAtom);
    const validateSelectedModel = useSetAtom(validateSelectedModelAtom);

    // Add this new useEffect to watch for API key changes
    useEffect(() => {
        validateSelectedModel();
    }, [availableModels, validateSelectedModel]);

    useEffect(() => {
        const loadAndInitializeModels = async () => {
            setIsLoading(true);
            
            // First initialize from preferences
            await initModels();
            
            // Check if we need to fetch fresh data
            const lastFetchedPref = getPref('supportedModelsLastFetched');
            const lastFetchedTime = lastFetchedPref ? parseInt(lastFetchedPref, 10) : 0;
            const timeSinceLastFetch = Date.now() - lastFetchedTime;
            
            // Check if any API keys are configured
            const hasAnyKey = 
                !!getPref('googleGenerativeAiApiKey') || 
                !!getPref('openAiApiKey') || 
                !!getPref('anthropicApiKey');
                
            // Fetch if needed (empty or outdated)
            if (hasAnyKey && (supportedModels.length === 0 || timeSinceLastFetch > REFETCH_INTERVAL_MS)) {
                await fetchModels();
            }
            
            setIsLoading(false);
        };
        
        loadAndInitializeModels();
    }, [initModels, fetchModels, supportedModels.length]);

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
                updateSelectedModel(DEFAULT_MODEL);
            },
            customContent: (
                <span className={`flex-1 text-sm truncate ${selectedModel.model_id === DEFAULT_MODEL.model_id ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                    {DEFAULT_MODEL.name}
                </span>
            )
        });

        items.push({
            label: 'Bring Your Own Key',
            isGroupHeader: true,
            onClick: () => {},
        });

        availableModels.forEach((model) => {
            items.push({
                label: model.name,
                onClick: () => {
                    updateSelectedModel(model);
                },
                icon: model.reasoning_model ? BrainIcon : undefined,
                customContent: (
                    <span className="display-flex items-center gap-2 min-w-0">
                        <span className={`flex text-sm truncate ${selectedModel.model_id === model.model_id ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                            {model.name}
                        </span>
                        {model.reasoning_model
                            ? <Icon icon={BrainIcon} className={`-ml-015 ${selectedModel.model_id === model.model_id ? 'font-medium font-color-primary' : 'font-color-secondary'}`} />
                            : undefined
                        }
                    </span>
                )
            });
        });

        return items;
    }, [availableModels, updateSelectedModel, selectedModel]);

    const hasAnyKey = 
        !!getPref('googleGenerativeAiApiKey') || 
        !!getPref('openAiApiKey') || 
        !!getPref('anthropicApiKey');
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
            icon={selectedModel.reasoning_model ? BrainIcon : undefined}
            rightIcon={ArrowDownIcon}
            className="truncate"
            style={{padding: '2px 0px', fontSize: '0.80rem', maxWidth: '120px'}}
            iconClassName="scale-11 -mr-015"
            rightIconClassName="scale-11 -ml-1"
            ariaLabel="Select AI Model"
            tooltipContent={isButtonDisabled ? 'Add your own API keys to select a model' : 'Choose AI model'}
            showArrow={false}
            disabled={isLoading || isButtonDisabled}
        />
    );
};

export default ModelSelectionButton;