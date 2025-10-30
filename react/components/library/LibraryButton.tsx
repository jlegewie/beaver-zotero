import React, { useState } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { CSSIcon } from '../icons/icons';
import { removeLibraryIdAtom, currentLibraryIdsAtom } from '../../atoms/messageComposition';
import { truncateText } from '../../utils/stringUtils';
import { selectLibrary } from '../../../src/utils/selectItem';

const MAX_LIBRARYBUTTON_TEXT_LENGTH = 20;

interface LibraryButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    library: Zotero.Library;
    canEdit?: boolean;
    disabled?: boolean;
}

export const LibraryButton: React.FC<LibraryButtonProps> = ({
    library,
    className,
    disabled = false,
    canEdit = true,
    ...rest
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const removeLibraryId = useSetAtom(removeLibraryIdAtom);
    const currentLibraryIds = useAtomValue(currentLibraryIdsAtom);
    const isValid = currentLibraryIds.includes(library.libraryID);

    const handleRemove = (e: React.MouseEvent<HTMLSpanElement>) => {
        e.stopPropagation();
        removeLibraryId(library.libraryID);
    };

    const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (!disabled) {
            selectLibrary(library);
        }
    };

    const getIconElement = () => {
        if (isHovered && canEdit) {
            return (
                <span role="button" className="source-remove" onClick={handleRemove}>
                    <CSSIcon name="x-8" className="icon-16" />
                </span>
            );
        }

        return (
            <span className="scale-90">
                <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16" />
            </span>
        );
    };

    const getButtonClasses = () => {
        const baseClasses = `variant-outline source-button ${className || ''} ${disabled ? 'disabled-but-styled' : ''}`;
        if (!isValid) {
            return `${baseClasses} border-red`;
        }
        return baseClasses;
    };

    const getTooltipTitle = () => {
        return "Search is restricted to the selected libraries";
    };

    const displayName = truncateText(library.name, MAX_LIBRARYBUTTON_TEXT_LENGTH);

    return (
        <button
            style={{ height: '22px' }}
            title={getTooltipTitle()}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            className={getButtonClasses()}
            disabled={disabled}
            onClick={handleButtonClick}
            {...rest}
        >
            {getIconElement()}
            <span className={`truncate ${!isValid ? 'font-color-red' : ''}`}>
                {displayName}
            </span>
        </button>
    );
};
