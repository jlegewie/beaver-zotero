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
    const creditCost = model.credit_cost ?? 1;
    return (
        <div className="display-flex flex-col min-w-0">
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <div className={`display-flex text-sm truncate ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                    {model.name}
                </div>
            </div>
            <div className="text-xs font-color-tertiary items-center">
                {showCreditCosts
                    ? <div className="text-xs">{creditCost} credit${creditCost !== 1 ? 's' : ''}</div>
                    : <div className="text-xs">Recommended</div>
                }
            </div>
        </div>
    );
};

/**
 * Button component for selecting the AI model to use for chat completions.
 * Displays available models based on configured API keys.
 */
const ModelSelectionButton: React.FC<{inputRef?: React.RefObject<HTMLTextAreaElement>, disabled?: boolean}> = ({ inputRef, disabled = false }) => {
    const selectedModel = useAtomValue(selectedModelAtom);
    const availableModels = useAtomValue(availableModelsAtom);

    const updateSelectedModel = useSetAtom(updateSelectedModelAtom);
    const validateSelectedModel = useSetAtom(validateSelectedModelAtom);

    // Watch for api key changes
    useEffect(() => {
        validateSelectedModel();
    }, [availableModels, validateSelectedModel]);

    const custom_models = useMemo(() => availableModels.filter((model) => model.is_custom), [availableModels]);
    const included_models = useMemo(() => availableModels.filter((model) => model.allow_app_key && model.is_enabled && !model.is_custom) || [], [availableModels]);
    const byok_models = useMemo(() => availableModels.filter((model) => model.allow_byok && model.is_enabled && !model.is_custom), [availableModels]);

    const menuItems = useMemo((): MenuItem[] => {
        const items: MenuItem[] = [];

        // Helper to create a composite key for selection comparison
        const getModelKey = (model: any) => {
            return `${model.id}:${model.access_mode || 'app_key'}`;
        };
        const selectedKey = selectedModel ? getModelKey(selectedModel) : null;

        included_models.sort((a, b) => a.name.localeCompare(b.name)).forEach((model) => {
            // Create a model variant with access_mode set to 'app_key'
            const modelWithAccessMode = { ...model, access_mode: 'app_key' as const };
            const modelKey = getModelKey(modelWithAccessMode);
            
            items.push({
                label: model.name,
                onClick: () => {
                    updateSelectedModel(modelWithAccessMode);
                },
                customContent: (
                    <ModelMenuItemContent 
                        model={model} 
                        isSelected={selectedKey === modelKey}
                        showCreditCosts={included_models.length > 1}
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
                const modelKey = getModelKey(model);
                
                items.push({
                    label: model.name,
                    onClick: () => {
                        updateSelectedModel(model);
                    },
                    customContent: (
                        <ModelMenuItemContent 
                            model={model} 
                            isSelected={selectedKey === modelKey}
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
                // Create a model variant with access_mode set to 'byok'
                const modelWithAccessMode = { ...model, access_mode: 'byok' as const };
                const modelKey = getModelKey(modelWithAccessMode);
                
                items.push({
                    label: model.name,
                    onClick: () => {
                        updateSelectedModel(modelWithAccessMode);
                    },
                    customContent: (
                        <ModelMenuItemContent 
                            model={model} 
                            isSelected={selectedKey === modelKey}
                        />
                    )
                });
            });
        }

        return items;
    }, [custom_models, included_models, byok_models, updateSelectedModel, selectedModel]);

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
            <Icon icon={BrainIcon} />
            {getButtonLabel()}
            <Icon icon={ArrowDownIcon} className="scale-11 -ml-1" />
        </div>
    );

    const dynamicStyle = {
        padding: '2px 0px',
        fontSize: '0.80rem',
        maxWidth: '250px',
    };

    if (custom_models.length == 0 && byok_models.length == 0) {
        return null;
    }

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost-secondary"
            customContent={agentComponent}
            buttonLabel={getButtonLabel()}
            rightIcon={ArrowDownIcon}
            className="truncate"
            style={dynamicStyle}
            iconClassName="scale-11 -mr-015"
            rightIconClassName="scale-11 -ml-1"
            ariaLabel="Select AI Model"
            tooltipContent={availableModels.length === 0 ? 'No models available' : 'Choose AI model'}
            showArrow={false}
            disabled={disabled || availableModels.length === 0}
            onAfterClose={handleAfterClose}
        />
    );
};

export default ModelSelectionButton;
