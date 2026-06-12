import React from 'react';
import { ViewImageReference } from '../../agents/toolResultTypes';
import ZoteroItemsList, { ZoteroItemReferenceWithLabel } from '../ui/ZoteroItemsList';
import { formatNumberRanges } from '../../utils/stringUtils';

interface ViewResultViewProps {
    kind: 'pdf' | 'image';
    images: ViewImageReference[];
}

/**
 * Renders the result of a unified `view` tool call.
 * Shows the attachment that was viewed with page information for PDFs;
 * image attachments are shown without a page label.
 */
export const ViewResultView: React.FC<ViewResultViewProps> = ({ kind, images }) => {
    // The actual images are rendered elsewhere in the UI; this shows the
    // attachment reference(s) with page context.
    if (images.length === 0) {
        return null;
    }

    // Group page numbers by unique attachment key
    const attachmentMap = new Map<string, { library_id: number; zotero_key: string; pages: number[] }>();

    for (const image of images) {
        const key = `${image.library_id}-${image.zotero_key}`;
        if (!attachmentMap.has(key)) {
            attachmentMap.set(key, {
                library_id: image.library_id,
                zotero_key: image.zotero_key,
                pages: []
            });
        }
        if (typeof image.page_number === 'number') {
            attachmentMap.get(key)!.pages.push(image.page_number);
        }
    }

    const attachments: ZoteroItemReferenceWithLabel[] = Array.from(attachmentMap.values()).map(data => ({
        library_id: data.library_id,
        zotero_key: data.zotero_key,
        label: kind === 'pdf' && data.pages.length > 0
            ? `Page ${formatNumberRanges(data.pages, ",")}`
            : 'Image',
    }));

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default ViewResultView;
