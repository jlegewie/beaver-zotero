import React, { useEffect, useMemo } from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { BrainIcon, ArrowDownIcon, Icon, AiMagicIcon } from '../../icons/icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { 
  selectedModelAtom,
  availableModelsAtom,
  updateSelectedModelAtom,
  validateSelectedModelAtom,
  isAgentModelAtom
} from '../../../atoms/models';

const MAX_MODEL_NAME_LENGTH = 25;

/**
 * Component for displaying a model menu item
 */
const ModelMenuItemContent: React.FC<{
    model: any;
    isSelected: boolean;
}> = ({ model, isSelected }) => {
    return (
        <div className="display-flex flex-row items-center gap-2 min-w-0">
            <div className={`display-flex text-sm truncate ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                {model.name}
            </div>
            {model.reasoning_model
                ? <Icon icon={BrainIcon} className={`-ml-015 ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`} />
                : undefined
            }
            {model.use_app_key &&
                <div className="text-xs font-color-quarternary items-center">
                    <div className="text-xs">{model.credit_cost > 0.001 ? `${model.credit_cost}x credits` : 'Unlimited'}</div>
                </div>
            }
            {/* {model.is_agent &&
                <div className="text-xs bg-quinary py-05 px-15 rounded-md font-color-secondary items-center gap-05">
                    <Icon icon={AiMagicIcon} />
                    <div className="text-xs">Agent</div>
                </div>
            } */}
        </div>
    );
};

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC<{inputRef?: React.RefObject<HTMLTextAreaElement>}> = ({ inputRef }) => {
    const isAgentModel = useAtomValue(isAgentModelAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const availableModels = useAtomValue(availableModelsAtom);

    const updateSelectedModel = useSetAtom(updateSelectedModelAtom);
    const validateSelectedModel = useSetAtom(validateSelectedModelAtom);

    // Watch for api key changes
    useEffect(() => {
        validateSelectedModel();
    }, [availableModels, validateSelectedModel]);

    const menuItems = useMemo((): MenuItem[] => {
        const items: MenuItem[] = [];

        const byok_models = availableModels.filter((model) => !model.use_app_key && !model.is_agent);
        const byok_models_agent = availableModels.filter((model) => !model.use_app_key && model.is_agent);
        const included_models = availableModels.filter((model) => model.use_app_key) || [];

        items.push({
            label: 'Included Models',
            isGroupHeader: true,
            onClick: () => {},
        });

        included_models.sort((a, b) => Number(b.is_default) - Number(a.is_default)).forEach((model) => {
            items.push({
                label: model.name,
                onClick: () => {
                    updateSelectedModel(model);
                },
                icon: model.reasoning_model ? BrainIcon : undefined,
                customContent: (
                    <ModelMenuItemContent 
                        model={model} 
                        isSelected={selectedModel !== null && selectedModel.access_id === model.access_id}
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
                            isSelected={selectedModel !== null && selectedModel.access_id === model.access_id}
                        />
                    )
                });
            });
        }

        if (byok_models_agent.length > 0) {
            items.push({
                label: 'Your API Keys',
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
                            isSelected={selectedModel !== null && selectedModel.access_id === model.access_id}
                        />
                    )
                });
            });
        }

        return items;
    }, [availableModels, updateSelectedModel, selectedModel]);

    const getButtonLabel = () => {
        if (!selectedModel) return 'None Selected';
        return selectedModel && selectedModel.name.length > MAX_MODEL_NAME_LENGTH
            ? `${selectedModel.name.slice(0, (MAX_MODEL_NAME_LENGTH - 2))}...`
            : selectedModel?.name || '';
    };

    const handleAfterClose = () => {
        if (inputRef?.current) {
            inputRef.current.focus();
        }
    };

    const agentComponent = (
        <div className="display-flex items-center gap-1">
            {(selectedModel?.reasoning_model || false) && <Icon icon={BrainIcon} />}
            {getButtonLabel()}
            {/* <div className="text-xs bg-quinary py-05 px-15 rounded-md font-color-secondary items-center gap-05">
                <Icon icon={AiMagicIcon} />
                <span>Agent</span>
            </div> */}
            <Icon icon={ArrowDownIcon} className="scale-11 -ml-1" />
        </div>
    );

    const dynamicStyle = {
        padding: '2px 0px',
        fontSize: '0.80rem',
        maxWidth: '250px',
    };


    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost-secondary"
            customContent={isAgentModel ? agentComponent : undefined}
            buttonLabel={getButtonLabel()}
            icon={selectedModel && selectedModel.reasoning_model ? BrainIcon : undefined}
            rightIcon={ArrowDownIcon}
            className="truncate"
            style={dynamicStyle}
            iconClassName="scale-11 -mr-015"
            rightIconClassName="scale-11 -ml-1"
            ariaLabel="Select AI Model"
            tooltipContent={availableModels.length === 0 ? 'No models available' : 'Choose AI model'}
            showArrow={false}
            disabled={availableModels.length === 0}
            onAfterClose={handleAfterClose}
        />
    );
};

export default ModelSelectionButton;