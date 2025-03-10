import React from 'react';
import { CSSItemTypeIcon } from '../icons';
import { InputSource } from '../../types/sources';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';

interface SourcePreviewHeadingProps {
    source: InputSource;
    item: Zotero.Item;
}

const SourcePreviewHeading: React.FC<SourcePreviewHeadingProps> = ({ source, item }) => {
    return (
        <span className="flex items-center font-color-primary">
            <span className="fit-content">
                {<CSSItemTypeIcon itemType={item.getItemTypeIconName()} className="scale-85" />}
            </span>
            <span className="ml-2 truncate">{getDisplayNameFromItem(item, source.childItemKeys.length)}</span>
        </span>
    );
};

export default SourcePreviewHeading;
