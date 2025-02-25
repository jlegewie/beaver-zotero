import React from 'react';
import { ZoteroAttachment } from '../../types/attachments';
import { CSSItemTypeIcon } from '../icons';

interface PreviewZoteroAttachmentProps {
    attachment: ZoteroAttachment;
}

const PreviewZoteroAttachment: React.FC<PreviewZoteroAttachmentProps> = ({ attachment }) => {
    const formatContent = (item: Zotero.Item) => {
        if (item.isNote()) {
            const title = item.getNoteTitle();
            const content = Zotero.Utilities.unescapeHTML(item.getNote());
            return content.replace(title, '').trim().slice(0, 30) + '...';
        }
        if (item.isAttachment()) {
            return item.getFilename();
        }
        return item.getDisplayTitle();
    };

    return (
        <>
            <span className="flex items-center font-color-primary">
                {<CSSItemTypeIcon itemType={attachment.item.getItemTypeIconName()} />}
                <span className="ml-2">{attachment.shortName}</span>
            </span>
            <p className="text-base my-2">{formatContent(attachment.item)}</p>
        </>
    );
};

export default PreviewZoteroAttachment; 