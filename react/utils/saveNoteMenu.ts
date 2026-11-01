import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import { NoteIcon } from '@beaver/agent-ui/icons';

/** Longest parent title shown in the child-note item before it is cut. */
const MAX_PARENT_TITLE_LENGTH = 40;

function shortTitle(title: string): string {
    const trimmed = title.trim();
    return trimmed.length > MAX_PARENT_TITLE_LENGTH
        ? `${trimmed.slice(0, MAX_PARENT_TITLE_LENGTH - 1).trimEnd()}…`
        : trimmed;
}

/**
 * A "Save as note" item whose submenu names where each note lands: a
 * standalone note, or a child note of the current item (named when the host
 * can name it). Without a parent item the child note stays listed, disabled,
 * so the menu keeps its shape and says why.
 */
export function saveAsNoteMenuItem(options: {
    onSaveStandalone: () => void;
    onSaveChild: () => void;
    /** Whether there is a parent item to save a child note under. */
    hasParent: boolean;
    parentTitle?: string | null;
    disabled?: boolean;
}): MenuItem {
    const { onSaveStandalone, onSaveChild, hasParent, parentTitle, disabled = false } = options;
    const childLabel = !hasParent
        ? 'Child note (no item selected)'
        : parentTitle?.trim()
            ? `Child note of “${shortTitle(parentTitle)}”`
            : 'Child note';
    return {
        label: 'Save as note',
        icon: NoteIcon,
        onClick: () => {},
        disabled,
        submenu: [
            { label: 'Standalone note', onClick: onSaveStandalone, disabled },
            { label: childLabel, onClick: onSaveChild, disabled: disabled || !hasParent },
        ],
    };
}

/** A divider row; `id` keeps labels unique within a menu. */
export function menuDivider(id: string): MenuItem {
    return { label: id, onClick: () => {}, isDivider: true };
}
