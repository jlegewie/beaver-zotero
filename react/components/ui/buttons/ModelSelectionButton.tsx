import React, { useEffect, useMemo } from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { BrainIcon, ArrowDownIcon, Icon } from '../../icons/icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { 
  selectedModelAtom,
  availableModelsAtom,
  updateSelectedModelAtom,
  validateSelectedModelAtom,
} from '../../../atoms/models';

const MAX_MODEL_NAME_LENGTH = 25;

/**
 * Component for displaying a model menu item
 */
const ModelMenuItemContent: React.FC<{
    model: any;
    isSelected: boolean;
    showCreditCosts?: boolean
}> = ({ model, isSelected,  showCreditCosts= false}) => {
    return (
        <div className="display-flex flex-row items-center gap-2 min-w-0">
            <div className={`display-flex text-sm truncate ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                {model.name}
            </div>
            {model.reasoning_model
                ? <Icon icon={BrainIcon} className={`-ml-015 ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`} />
                : undefined
            }
            {showCreditCosts && model.credit_cost &&
                <div className="text-xs font-color-quarternary items-center">
                    <div className="text-xs">{model.credit_cost > 0.001 ? `${model.credit_cost}x credits` : 'Unlimited'}</div>
                </div>
            }
        </div>
    );
};

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC<{inputRef?: React.RefObject<HTMLTextAreaElement>}> = ({ inputRef }) => {
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

        const custom_models = availableModels.filter((model) => model.is_custom);
        const included_models = availableModels.filter((model) => model.allow_app_key && model.is_enabled && !model.is_custom) || [];
        const byok_models = availableModels.filter((model) => model.allow_byok && model.is_enabled && !model.is_custom);

        if (included_models.length > 0) {
            items.push({
                label: 'Included Models',
                isGroupHeader: true,
                onClick: () => {},
            });
        }

        included_models.sort((a, b) => a.name.localeCompare(b.name)).forEach((model) => {
            items.push({
                label: model.name,
                onClick: () => {
                    updateSelectedModel(model);
                },
                icon: model.reasoning_model ? BrainIcon : undefined,
                customContent: (
                    <ModelMenuItemContent 
                        model={model} 
                        isSelected={selectedModel !== null && selectedModel.id === model.id}
                        showCreditCosts={true}
                    />
                )
            });
        });

        if (custom_models.length > 0) {
            items.push({
                label: 'Custom Models',
                isGroupHeader: true,
                onClick: () => {},
            });

            custom_models.forEach((model) => {
                items.push({
                    label: model.name,
                    onClick: () => {
                        updateSelectedModel(model);
                    },
                    icon: model.reasoning_model ? BrainIcon : undefined,
                    customContent: (
                        <ModelMenuItemContent 
                            model={model} 
                            isSelected={selectedModel !== null && selectedModel.id === model.id}
                        />
                    )
                });
            });
        }

        if (byok_models.length > 0) {
            items.push({
                label: 'Your API Keys',
                isGroupHeader: true,
                onClick: () => {},
            });

            byok_models.sort((a, b) => a.name.localeCompare(b.name)).forEach((model) => {
                items.push({
                    label: model.name,
                    onClick: () => {
                        updateSelectedModel(model);
                    },
                    icon: model.reasoning_model ? BrainIcon : undefined,
                    customContent: (
                        <ModelMenuItemContent 
                            model={model} 
                            isSelected={selectedModel !== null && selectedModel.id === model.id}
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
            customContent={agentComponent}
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
