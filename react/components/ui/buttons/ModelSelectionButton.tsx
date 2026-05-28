import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import type { ModelConfig } from '../../../atoms/models';

const MAX_MODEL_NAME_LENGTH = 25;

const getModelSelectionKey = (model: Pick<ModelConfig, 'id' | 'access_mode'>) => {
    return `${model.id}:${model.access_mode || 'app_key'}`;
};

const isBeaverModel = (model: Pick<ModelConfig, 'access_mode' | 'allow_app_key' | 'is_custom'>) => {
    return !model.is_custom && (model.access_mode === 'app_key' || (!model.access_mode && model.allow_app_key));
};

const getAccessibleModelLabel = (model: ModelConfig | null, isRecommended = false) => {
    if (!model) {
        return 'None Selected';
    }
    if (isBeaverModel(model)) {
        return isRecommended ? 'Beaver model (recommended)' : `Beaver model: ${model.name}`;
    }
    return model.name;
};

/**
 * Component for displaying a model menu item
 */
const ModelMenuItemContent: React.FC<{
    model: any;
    isSelected: boolean;
    showCreditCosts?: boolean;
    showRecommended?: boolean;
}> = ({ model, isSelected, showCreditCosts = false, showRecommended = false }) => {
    const creditCost = model.credit_cost ?? 1;
    return (
        <div className="display-flex flex-col min-w-0">
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <div className={`display-flex text-sm truncate ${isSelected ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                    {model.name}
                </div>
            </div>
            {(showCreditCosts || showRecommended) && (
                <div className="text-xs font-color-tertiary items-center">
                    {showCreditCosts ? (
                        <div className="text-xs">{creditCost} credit${creditCost !== 1 ? 's' : ''}</div>
                    ) : showRecommended ? (
                        <div className="text-xs">Recommended</div>
                    ) : null}
                </div>
            )}
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
    const liveRegionRef = useRef<HTMLDivElement | null>(null);
    const previousSelectedKeyRef = useRef<string | null>(null);
    const hasInitializedSelectionRef = useRef(false);
    const announcementTimerRef = useRef<{ win: Window; id: number } | null>(null);
    const [selectionAnnouncement, setSelectionAnnouncement] = useState('');

    const updateSelectedModel = useSetAtom(updateSelectedModelAtom);
    const validateSelectedModel = useSetAtom(validateSelectedModelAtom);
    const selectedKey = selectedModel ? getModelSelectionKey(selectedModel) : null;
    const custom_models = useMemo(() => availableModels.filter((model) => model.is_custom), [availableModels]);
    const included_models = useMemo(() => availableModels.filter((model) => model.allow_app_key && model.is_enabled && !model.is_custom) || [], [availableModels]);
    const byok_models = useMemo(() => availableModels.filter((model) => model.allow_byok && model.is_enabled && !model.is_custom), [availableModels]);
    const selectedModelAccessibleLabel = getAccessibleModelLabel(
        selectedModel,
        !!selectedModel && included_models.length === 1 && isBeaverModel(selectedModel),
    );

    // Watch for api key changes
    useEffect(() => {
        validateSelectedModel();
    }, [availableModels, validateSelectedModel]);

    useEffect(() => {
        return () => {
            if (announcementTimerRef.current) {
                announcementTimerRef.current.win.clearTimeout(announcementTimerRef.current.id);
            }
        };
    }, []);

    useEffect(() => {
        if (!hasInitializedSelectionRef.current) {
            hasInitializedSelectionRef.current = true;
            previousSelectedKeyRef.current = selectedKey;
            return;
        }

        if (previousSelectedKeyRef.current === selectedKey) {
            return;
        }

        previousSelectedKeyRef.current = selectedKey;
        const message = selectedModel
            ? `Selected AI model: ${selectedModelAccessibleLabel}`
            : 'No AI model selected';

        if (announcementTimerRef.current) {
            announcementTimerRef.current.win.clearTimeout(announcementTimerRef.current.id);
            announcementTimerRef.current = null;
        }

        // Clear first so selecting the same visible name through a different
        // access mode is still announced by screen readers.
        setSelectionAnnouncement('');
        const win = liveRegionRef.current?.ownerDocument.defaultView;
        if (!win) {
            setSelectionAnnouncement(message);
            return;
        }

        const id = win.setTimeout(() => {
            setSelectionAnnouncement(message);
            announcementTimerRef.current = null;
        }, 50);
        announcementTimerRef.current = { win, id };
    }, [selectedKey, selectedModel, selectedModelAccessibleLabel]);

    const menuItems = useMemo((): MenuItem[] => {
        const items: MenuItem[] = [];

        included_models.sort((a, b) => a.name.localeCompare(b.name)).forEach((model) => {
            // Create a model variant with access_mode set to 'app_key'
            const modelWithAccessMode = { ...model, access_mode: 'app_key' as const };
            const modelKey = getModelSelectionKey(modelWithAccessMode);
            const accessibleLabel = getAccessibleModelLabel(modelWithAccessMode, included_models.length === 1);
            
            items.push({
                label: accessibleLabel,
                role: 'menuitemradio',
                ariaChecked: selectedKey === modelKey,
                onClick: () => {
                    updateSelectedModel(modelWithAccessMode);
                },
                customContent: (
                    <ModelMenuItemContent 
                        model={model} 
                        isSelected={selectedKey === modelKey}
                        showCreditCosts={included_models.length > 1}
                        showRecommended={included_models.length === 1}
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
                const modelKey = getModelSelectionKey(model);
                
                items.push({
                    label: model.name,
                    role: 'menuitemradio',
                    ariaChecked: selectedKey === modelKey,
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
                const modelKey = getModelSelectionKey(modelWithAccessMode);
                
                items.push({
                    label: model.name,
                    role: 'menuitemradio',
                    ariaChecked: selectedKey === modelKey,
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
    }, [custom_models, included_models, byok_models, updateSelectedModel, selectedKey]);

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

    if (menuItems.length <= 1) {
        return null;
    }

    return (
        <>
            <div
                ref={liveRegionRef}
                className="sr-only"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {selectionAnnouncement}
            </div>
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
                ariaLabel={`AI model: ${selectedModelAccessibleLabel}. Choose AI model`}
                tooltipContent={availableModels.length === 0 ? 'No models available' : 'Choose AI model'}
                showArrow={false}
                disabled={disabled || availableModels.length === 0}
                onAfterClose={handleAfterClose}
            />
        </>
    );
};

export default ModelSelectionButton;
