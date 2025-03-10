import React from 'react';
import { InputSource } from '../../types/sources';
import SourcePreviewHeading from './SourcePreviewHeading';
interface SourcePreviewAttachmentProps {
    source: InputSource;
    item: Zotero.Item;
}

const MAX_NOTE_CONTENT_LENGTH = 250;

const SourcePreviewAttachment: React.FC<SourcePreviewAttachmentProps> = ({ source, item }) => {
    const formatContent = (item: Zotero.Item) => {
        if (item.isNote()) {
            const title = item.getNoteTitle();
            // @ts-ignore getNote exists
            const content = Zotero.Utilities.unescapeHTML(item.getNote());
            return content.replace(title, '').trim().slice(0, MAX_NOTE_CONTENT_LENGTH) + '...';
        }
        if (item.isAttachment()) {
            return item.attachmentFilename;
        }
        return item.getDisplayTitle();
    };

    return (
        <>
            <SourcePreviewHeading source={source} item={item}/>
            <p className="text-base my-2">{formatContent(item)}</p>
        </>
    );
};

export default SourcePreviewAttachment; 