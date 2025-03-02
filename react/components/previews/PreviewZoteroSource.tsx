import React from 'react';
import { ZoteroSource } from '../../types/sources';
import { CSSItemTypeIcon } from '../icons';
import PreviewHeading from './PreviewHeading';
interface PreviewZoteroSourceProps {
    source: ZoteroSource;
    item: Zotero.Item;
}

const MAX_NOTE_CONTENT_LENGTH = 250;

const PreviewZoteroSource: React.FC<PreviewZoteroSourceProps> = ({ source, item }) => {
    const formatContent = (item: Zotero.Item) => {
        if (item.isNote()) {
            const title = item.getNoteTitle();
            // @ts-ignore getNote exists
            const content = Zotero.Utilities.unescapeHTML(item.getNote());
            return content.replace(title, '').trim().slice(0, MAX_NOTE_CONTENT_LENGTH) + '...';
        }
        if (item.isAttachment()) {
            // @ts-ignore getFilename exists
            return item.getFilename();
        }
        return item.getDisplayTitle();
    };

    return (
        <>
            <PreviewHeading source={source} item={item}/>
            <p className="text-base my-2">{formatContent(item)}</p>
        </>
    );
};

export default PreviewZoteroSource; 