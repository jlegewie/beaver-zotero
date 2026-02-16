import React from 'react';
import MenuButton from '../ui/MenuButton';
import { ArrowDownIcon } from '../icons/icons';
import { MenuItem } from '../ui/menu/ContextMenu';

interface ShortcutSelectorProps {
    value?: number;
    onChange: (value: number | undefined) => void;
    usedShortcuts: number[];
}

const ShortcutSelector: React.FC<ShortcutSelectorProps> = ({
    value,
    onChange,
    usedShortcuts,
}) => {
    const isMac = Zotero.isMac;
    const formatShortcut = (n: number) => isMac ? `⌘^${n}` : `Ctrl+Win+${n}`;

    const menuItems: MenuItem[] = [
        {
            label: 'None',
            onClick: () => onChange(undefined),
            customContent: (
                <span className="text-sm font-color-primary">None</span>
            )
        },
        ...Array.from({ length: 9 }, (_, i) => i + 1).map((n) => ({
            label: formatShortcut(n),
            onClick: () => onChange(n),
            disabled: usedShortcuts.includes(n),
            customContent: (
                <span className="text-sm font-color-primary w-full">{formatShortcut(n)}</span>
            )
        }))
    ];

    const currentLabel = value ? formatShortcut(value) : 'None';

    return (
        <MenuButton
            menuItems={menuItems}
            className="preference-input font-color-tertiary text-xs display-flex items-center justify-between cursor-pointer"
            style={{ 
                padding: '0px 6px',
                height: '20px',
                width: '52px',
                gap: '2px'
            }}
            customContent={
                <div className="display-flex items-center justify-between w-full">
                    <span className="truncate text-xs">{currentLabel}</span>
                    <ArrowDownIcon className="flex-shrink-0 opacity-70" width={10} height={10} />
                </div>
            }
            ariaLabel="Select shortcut"
            maxHeight="200px"
        />
    );
};

export default ShortcutSelector;
