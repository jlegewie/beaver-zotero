import React from 'react';
import { CSSItemTypeIcon } from '../icons';
import { Source } from '../../types/sources';

interface PreviewHeadingProps {
    source: Source;
    item?: Zotero.Item;
}

const PreviewHeading: React.FC<PreviewHeadingProps> = ({ source, item }) => {
    return (
        <span className="flex items-center font-color-primary">
            <span className="fit-content">
                {<CSSItemTypeIcon itemType={item ? item.getItemTypeIconName() : source.icon} className="scale-85" />}
            </span>
            <span className="ml-2 truncate">{source.name}</span>
        </span>
    );
};

export default PreviewHeading;
