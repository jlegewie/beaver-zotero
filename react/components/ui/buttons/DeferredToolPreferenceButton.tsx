import React, { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { ArrowDownIcon, Icon, TickIcon } from '../../icons/icons';
import {
    DeferredToolPreference,
    getPreferenceForToolAtom,
    updateToolPreferenceAtom,
    DEFERRED_TOOL_PREFERENCE_LABELS,
} from '../../../atoms/deferredToolPreferences';

interface DeferredToolPreferenceButtonProps {
    /** The tool name to get/set preference for */
    toolName: string;
    /** Optional callback after preference changes */
    onPreferenceChange?: (preference: DeferredToolPreference) => void;
    /** Optional allowed preference subset (defaults to all deferred preferences) */
    allowedPreferences?: DeferredToolPreference[];
}

/**
 * Dropdown button for selecting the preference for a deferred tool action.
 * Shows the current preference and allows changing it.
 */
const DeferredToolPreferenceButton: React.FC<DeferredToolPreferenceButtonProps> = ({
    toolName,
    onPreferenceChange,
    allowedPreferences,
}) => {
    const getPreferenceForTool = useAtomValue(getPreferenceForToolAtom);
    const updateToolPreference = useSetAtom(updateToolPreferenceAtom);
    
    const currentPreference = getPreferenceForTool(toolName);

    const handleSelect = (preference: DeferredToolPreference) => {
        updateToolPreference({ toolName, preference });
        onPreferenceChange?.(preference);
    };

    const menuItems = useMemo((): MenuItem[] => {
        const preferences: DeferredToolPreference[] = allowedPreferences ?? [
            'always_ask',
            'always_apply',
            'continue_without_applying',
        ];

        return preferences.map((pref) => ({
            label: DEFERRED_TOOL_PREFERENCE_LABELS[pref],
            onClick: () => handleSelect(pref),
            customContent: (
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <div className={`display-flex text-sm ${currentPreference === pref ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                        {DEFERRED_TOOL_PREFERENCE_LABELS[pref]}
                    </div>
                    {currentPreference === pref && (
                        <Icon icon={TickIcon} className="font-color-primary scale-11" />
                    )}
                </div>
            ),
        }));
    }, [allowedPreferences, currentPreference, toolName]);

    const buttonLabel = DEFERRED_TOOL_PREFERENCE_LABELS[currentPreference];

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost-secondary"
            buttonLabel={buttonLabel}
            rightIcon={ArrowDownIcon}
            style={{
                padding: '2px 2px',
                fontSize: '0.90rem',
            }}
            rightIconClassName="scale-11 -ml-05"
            ariaLabel="Select action preference"
            tooltipContent="How to handle this action"
            showArrow={false}
        />
    );
};

export default DeferredToolPreferenceButton;
