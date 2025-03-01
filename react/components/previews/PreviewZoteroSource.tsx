import React from 'react';
import { ZoteroSource } from '../../types/sources';
import { CSSItemTypeIcon } from '../icons';

interface PreviewZoteroSourceProps {
    source: ZoteroSource;
    item: Zotero.Item;
}

const PreviewZoteroSource: React.FC<PreviewZoteroSourceProps> = ({ source, item }) => {
    const formatContent = (item: Zotero.Item) => {
        if (item.isNote()) {
            const title = item.getNoteTitle();
            // @ts-ignore getNote exists
            const content = Zotero.Utilities.unescapeHTML(item.getNote());
            return content.replace(title, '').trim().slice(0, 30) + '...';
        }
        if (item.isAttachment()) {
            // @ts-ignore getFilename exists
            return item.getFilename();
        }
        return item.getDisplayTitle();
    };

    return (
        <>
            <span className="flex items-center font-color-primary">
                {<CSSItemTypeIcon itemType={item.getItemTypeIconName()} />}
                <span className="ml-2">{source.name}</span>
            </span>
            <p className="text-base my-2">{formatContent(item)}</p>
        </>
    );
};

export default PreviewZoteroSource; 