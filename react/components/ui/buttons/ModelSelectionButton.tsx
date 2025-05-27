import React, { useState, useEffect, useMemo } from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { BrainIcon, ArrowDownIcon, Icon, AiMagicIcon } from '../../icons';
import { getPref } from '../../../../src/utils/prefs';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { 
  selectedModelAtom, 
  DEFAULT_MODEL, 
  supportedModelsAtom, 
  availableModelsAtom,
  initModelsAtom,
  fetchModelsAtom, 
  updateSelectedModelAtom,
  validateSelectedModelAtom,
  isAgentModelAtom
} from '../../../atoms/models';

const MAX_MODEL_NAME_LENGTH = 17;
const REFETCH_INTERVAL_HOURS = 6;
const REFETCH_INTERVAL_MS = REFETCH_INTERVAL_HOURS * 60 * 60 * 1000;

/**
 * Component for displaying a model menu item
 */
const ModelMenuItemContent: React.FC<{
    model: any;
    isSelected: boolean;
}> = ({ model, isSelected }) => {
    return (
        <span className="display-flex items-center gap-2 min-w-0">
            <span className={`display-flex text-sm truncate ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                {model.name}
            </span>
            {model.reasoning_model
                ? <Icon icon={BrainIcon} className={`-ml-015 ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`} />
                : undefined
            }
            {model.is_agent &&
                <div className="text-xs bg-quinary py-05 px-15 rounded-md font-color-secondary items-center gap-05">
                    <Icon icon={AiMagicIcon} />
                    <span className="text-xs">Agent</span>
                </div>
            }
        </span>
    );
};

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC<{inputRef?: React.RefObject<HTMLTextAreaElement>}> = ({ inputRef }) => {
    const [isLoading, setIsLoading] = useState(true);
    const isAgentModel = useAtomValue(isAgentModelAtom);
    const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom);
    const supportedModels = useAtomValue(supportedModelsAtom);
    const availableModels = useAtomValue(availableModelsAtom);
    const initModels = useAtom(initModelsAtom)[1];
    const fetchModels = useAtom(fetchModelsAtom)[1];
    const updateSelectedModel = useSetAtom(updateSelectedModelAtom);
    const validateSelectedModel = useSetAtom(validateSelectedModelAtom);

    // Watch for api key changes
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

        const byok_models = availableModels.filter((model) => !model.app_key && !model.is_agent);
        const byok_models_agent = availableModels.filter((model) => !model.app_key && model.is_agent);
        const included_models = availableModels.filter((model) => model.app_key) || [DEFAULT_MODEL];

        items.push({
            label: 'Included Models',
            isGroupHeader: true,
            onClick: () => {},
        });

        (included_models.length ? included_models : [DEFAULT_MODEL]).forEach((model) => {
            items.push({
                label: model.name,
                onClick: () => {
                    updateSelectedModel(model);
                },
                icon: model.reasoning_model ? BrainIcon : undefined,
                customContent: (
                    <ModelMenuItemContent 
                        model={model} 
                        isSelected={selectedModel.id === model.id}
                    />
                )
            });
        });

        if (byok_models.length > 0) {
            items.push({
                label: 'Your API Keys',
                isGroupHeader: true,
                onClick: () => {},
            });

            byok_models.forEach((model) => {
                items.push({
                    label: model.name,
                    onClick: () => {
                        updateSelectedModel(model);
                    },
                    icon: model.reasoning_model ? BrainIcon : undefined,
                    customContent: (
                        <ModelMenuItemContent 
                            model={model} 
                            isSelected={selectedModel.id === model.id}
                        />
                    )
                });
            });
        }

        if (byok_models_agent.length > 0) {
            items.push({
                label: 'Your API Keys: Agents',
                isGroupHeader: true,
                onClick: () => {},
            });

            byok_models_agent.forEach((model) => {
                items.push({
                    label: model.name,
                    onClick: () => {
                        updateSelectedModel(model);
                    },
                    icon: model.reasoning_model ? BrainIcon : undefined,
                    customContent: (
                        <ModelMenuItemContent 
                            model={model} 
                            isSelected={selectedModel.id === model.id}
                        />
                    )
                });
            });
        }

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

    const handleAfterClose = () => {
        if (inputRef?.current) {
            inputRef.current.focus();
        }
    };

    const agentComponent = (
        <div className="display-flex items-center gap-1">
            {selectedModel.reasoning_model && <Icon icon={BrainIcon} />}
            {getButtonLabel()}
            <div className="text-xs bg-quinary py-05 px-15 rounded-md font-color-secondary items-center gap-05">
                <Icon icon={AiMagicIcon} />
                <span>Agent</span>
            </div>
            <Icon icon={ArrowDownIcon} className="scale-11 -ml-1" />
        </div>
    );

    const dynamicStyle = {
        padding: '2px 0px',
        fontSize: '0.80rem',
        maxWidth: isAgentModel ? '250px' : '120px',
    };


    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost-secondary"
            customContent={isAgentModel ? agentComponent : undefined}
            buttonLabel={getButtonLabel()}
            icon={selectedModel.reasoning_model ? BrainIcon : undefined}
            rightIcon={ArrowDownIcon}
            className="truncate"
            style={dynamicStyle}
            iconClassName="scale-11 -mr-015"
            rightIconClassName="scale-11 -ml-1"
            ariaLabel="Select AI Model"
            tooltipContent={isButtonDisabled ? 'Add your own API keys to select a model' : 'Choose AI model'}
            showArrow={false}
            disabled={isLoading || isButtonDisabled}
            onAfterClose={handleAfterClose}
        />
    );
};

export default ModelSelectionButton;