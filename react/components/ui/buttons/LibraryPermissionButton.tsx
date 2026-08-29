import React from 'react';
import PermissionMenu, { PermissionMenuOption } from '@beaver/agent-ui/primitives/PermissionMenu';
import HandIcon from '@beaver/agent-ui/icons/HandIcon';
import SecurityWarningIcon from '@beaver/agent-ui/icons/SecurityWarningIcon';
import type { LibraryPermissionMode } from '../../../atoms/libraryPermission';

export type { LibraryPermissionMode };

export const LIBRARY_PERMISSION_HEADING = 'How should library changes be approved?';

/**
 * The Zotero-side copy for the shared permission menu. The menu itself is
 * client-agnostic; a document-hosted client supplies its own option set.
 */
export const LIBRARY_PERMISSION_OPTIONS: readonly PermissionMenuOption<LibraryPermissionMode>[] = [
    {
        value: 'ask',
        label: 'Ask permission',
        description: 'Follow the approval settings in Preferences',
        icon: HandIcon,
    },
    {
        value: 'full_access',
        label: 'Full access',
        // Names the blast radius rather than the common case: this mode also
        // overrides the approval settings in Preferences and the two changes
        // that otherwise always ask — deleting annotations, and rewriting a
        // note wholesale.
        description: 'Apply every change including deletions without asking',
        icon: SecurityWarningIcon,
        tone: 'warning',
    },
];

/** The trigger's tooltip in either layout: what the active mode means. */
const LIBRARY_PERMISSION_TOOLTIPS: Record<LibraryPermissionMode, string> = {
    ask: 'Beaver asks before it changes your library',
    full_access: 'Beaver changes your library without asking',
};

interface LibraryPermissionButtonProps {
    mode: LibraryPermissionMode;
    onChange: (mode: LibraryPermissionMode) => void;
    disabled?: boolean;
    /** Render the trigger as its icon alone, for a tight toolbar. */
    iconOnly?: boolean;
    /** Button variant, so the trigger can match whichever control it sits by. */
    variant?: string;
    className?: string;
    style?: React.CSSProperties;
    onAfterClose?: () => void;
}

/**
 * The library-changes permission control: the shared `PermissionMenu` with
 * Beaver's Zotero copy. Presentational — the caller owns where the mode is
 * stored, since persistent per-tool preferences live in
 * `atoms/deferredToolPreferences` and carry their own safety carve-outs.
 */
const LibraryPermissionButton: React.FC<LibraryPermissionButtonProps> = ({
    mode,
    onChange,
    disabled = false,
    iconOnly = false,
    variant,
    className,
    style,
    onAfterClose,
}) => (
    <PermissionMenu
        options={LIBRARY_PERMISSION_OPTIONS}
        value={mode}
        onChange={onChange}
        heading={LIBRARY_PERMISSION_HEADING}
        disabled={disabled}
        iconOnly={iconOnly}
        variant={variant}
        className={className}
        style={style}
        tooltipContent={LIBRARY_PERMISSION_TOOLTIPS[mode]}
        onAfterClose={onAfterClose}
    />
);

export default LibraryPermissionButton;
