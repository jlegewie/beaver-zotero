import React from 'react';
import { ZoteroResource } from '../../types/resources';
import { CSSItemTypeIcon } from '../icons';

interface PreviewZoteroResourceProps {
    resource: ZoteroResource;
    item: Zotero.Item;
}

const PreviewZoteroResource: React.FC<PreviewZoteroResourceProps> = ({ resource, item }) => {
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
                <span className="ml-2">{resource.name}</span>
            </span>
            <p className="text-base my-2">{formatContent(item)}</p>
        </>
    );
};

export default PreviewZoteroResource; 