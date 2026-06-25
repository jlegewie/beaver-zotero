import React from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { CSSIcon, LibraryIcon } from '../icons/icons';
import { removeLibraryIdAtom } from '../../atoms/messageComposition';
import { truncateText } from '../../utils/stringUtils';
import { selectLibrary } from '../../../src/utils/selectItem';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { useRemoveContextMenu } from '../../hooks/useRemoveContextMenu';
import { ChipWithPopup, type ChipPopupContent } from '../agentRuns/requestChips/ChipPopup';
import { ChipButton } from '../agentRuns/requestChips/ChipButton';
import { ChipRemovableIcon } from '../agentRuns/requestChips/ChipRemovableIcon';

const MAX_LIBRARYBUTTON_TEXT_LENGTH = 20;

interface LibraryButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    library: Zotero.Library;
    canEdit?: boolean;
    disabled?: boolean;
    /** Long-press the remove "x" to clear every editable context item at once. */
    onRemoveAll?: () => void;
}

export const LibraryButton: React.FC<LibraryButtonProps> = ({
    library,
    className,
    disabled = false,
    canEdit = true,
    onRemoveAll,
    ...rest
}) => {
    const removeLibraryId = useSetAtom(removeLibraryIdAtom);
    // Use searchableLibraryIds: Free users can search ALL libraries, Pro users can search synced only
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const isValid = searchableLibraryIds.includes(library.libraryID);

    const { isRemoveMenuOpen, contextMenuHandlers, removeHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => removeLibraryId(library.libraryID),
        onRemoveAll,
        canEdit,
        disabled,
        // Mirror the button click: select (reveal) the library.
        extraMenuItems: [{
            label: 'Reveal Library',
            icon: LibraryIcon,
            onClick: () => selectLibrary(library),
        }],
    });

    const normalIcon = (
        <span className="scale-90">
            <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16" />
        </span>
    );

    const getButtonClasses = () => {
        const classes = `${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
        if (!isValid) {
            return `${classes} border-red`;
        }
        return classes;
    };

    const displayName = truncateText(library.name, MAX_LIBRARYBUTTON_TEXT_LENGTH);

    const popup: ChipPopupContent = {
        icon: (
            <span className="scale-90">
                <CSSIcon name={library.isGroup ? 'library-group' : 'library'} className="icon-16" />
            </span>
        ),
        title: library.name,
        subtitle: { text: 'Search filter' },
        action: { icon: LibraryIcon, label: 'Reveal in library' },
    };

    return (
        <>
        <ChipWithPopup popup={popup} suppressed={isRemoveMenuOpen}>
            <ChipButton
                {...contextMenuHandlers}
                className={getButtonClasses()}
                disabled={disabled}
                onClick={() => selectLibrary(library)}
                {...rest}
            >
                {canEdit ? (
                    <ChipRemovableIcon
                        normalIcon={normalIcon}
                        removeHandlers={removeHandlers}
                        removeMenuOpen={isRemoveMenuOpen}
                    />
                ) : normalIcon}
                <span className={`truncate ${!isValid ? 'font-color-red' : ''}`}>
                    {displayName}
                </span>
                <CSSIcon name="filter" className="icon-16 scale-60 mt-015 -ml-1" style={{ fill: 'var(--fill-tertiary)' }} />
            </ChipButton>
        </ChipWithPopup>
        {removeMenu}
        </>
    );
};
