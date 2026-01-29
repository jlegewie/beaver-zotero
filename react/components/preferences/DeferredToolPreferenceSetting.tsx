import React, { useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import MenuButton from '../ui/MenuButton';
import { MenuItem } from '../ui/menu/ContextMenu';
import { ArrowDownIcon, Icon, TickIcon } from '../icons/icons';
import {
    DeferredToolPreference,
    getPreferenceForToolAtom,
    updateToolPreferenceAtom,
    DEFERRED_TOOL_PREFERENCE_LABELS,
    DEFERRED_TOOL_PREFERENCE_DESCRIPTIONS,
} from '../../atoms/deferredToolPreferences';

interface DeferredToolPreferenceSettingProps {
    /** The tool name to get/set preference for */
    toolName: string;
    /** Display label for the setting */
    label: string;
    /** Description of what this permission controls */
    description: string;
    /** Optional tooltip for more info */
    tooltip?: string;
}

/**
 * A preference row for configuring how a deferred tool action should behave.
 */
const DeferredToolPreferenceSetting: React.FC<DeferredToolPreferenceSettingProps> = ({
    toolName,
    label,
    description,
    tooltip,
}) => {
    const getPreferenceForTool = useAtomValue(getPreferenceForToolAtom);
    const updateToolPreference = useSetAtom(updateToolPreferenceAtom);
    
    const currentPreference = getPreferenceForTool(toolName);

    const handleSelect = (preference: DeferredToolPreference) => {
        updateToolPreference({ toolName, preference });
    };

    const menuItems = useMemo((): MenuItem[] => {
        const preferences: DeferredToolPreference[] = [
            'always_ask',
            'always_apply',
            'continue_without_applying',
        ];

        return preferences.map((pref) => ({
            label: DEFERRED_TOOL_PREFERENCE_LABELS[pref],
            onClick: () => handleSelect(pref),
            customContent: (
                <div className="display-flex flex-col gap-05 min-w-0 py-05 items-start">
                    <div className="display-flex flex-row items-center gap-2">
                        <div className={`text-sm ${currentPreference === pref ? 'font-medium font-color-primary' : 'font-color-secondary'}`}>
                            {DEFERRED_TOOL_PREFERENCE_LABELS[pref]}
                        </div>
                        {currentPreference === pref && (
                            <Icon icon={TickIcon} className="font-color-primary scale-11" />
                        )}
                    </div>
                    <div className="text-xs font-color-tertiary">
                        {DEFERRED_TOOL_PREFERENCE_DESCRIPTIONS[pref]}
                    </div>
                </div>
            ),
        }));
    }, [currentPreference, toolName]);

    const buttonLabel = DEFERRED_TOOL_PREFERENCE_LABELS[currentPreference];

    return (
        <div className="display-flex flex-row items-start justify-between gap-4">
            <div className="display-flex flex-col gap-05 flex-1 min-w-0">
                <div className="display-flex flex-row items-center gap-2">
                    <div className="font-color-primary text-base">
                        {label}
                    </div>
                </div>
                <div className="font-color-secondary text-sm">
                    {description}
                </div>
            </div>
            <MenuButton
                menuItems={menuItems}
                variant="outline"
                width="180px"
                customContent={
                    <div className="display-flex flex-row items-center justify-between gap-2 w-full px-2">
                        <span className="text-sm font-color-primary">{buttonLabel}</span>
                        <Icon icon={ArrowDownIcon} className="scale-11 font-color-secondary" />
                    </div>
                }
                style={{
                    padding: '4px 2px',
                }}
                ariaLabel={`Select preference for ${label}`}
            />
        </div>
    );
};

export default DeferredToolPreferenceSetting;
