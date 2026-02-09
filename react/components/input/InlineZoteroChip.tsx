import React from 'react';
import { CSSItemTypeIcon } from '../icons/icons';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import { truncateText } from '../../utils/stringUtils';

interface InlineZoteroChipProps {
    libraryId: number;
    zoteroKey: string;
}

const CHIP_MAX_LENGTH = 25;

const InlineZoteroChip: React.FC<InlineZoteroChipProps> = ({ libraryId, zoteroKey }) => {
    let item: Zotero.Item | false;
    try {
        item = Zotero.Items.getByLibraryAndKey(libraryId, zoteroKey);
    } catch {
        item = false;
    }

    if (!item) {
        return (
            <span className="inline-zotero-chip inline-zotero-chip-invalid">
                @{libraryId}-{zoteroKey}
            </span>
        );
    }

    const displayName = truncateText(getDisplayNameFromItem(item), CHIP_MAX_LENGTH);
    const itemType = item.itemType;

    const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            const zp = Zotero.getActiveZoteroPane();
            if (zp) {
                zp.selectItem(item.id);
            }
        } catch {
            // Ignore navigation errors
        }
    };

    return (
        <span
            className="inline-zotero-chip"
            onClick={handleClick}
            title={getDisplayNameFromItem(item)}
        >
            <CSSItemTypeIcon itemType={itemType} />
            {displayName}
        </span>
    );
};

export default React.memo(InlineZoteroChip);
