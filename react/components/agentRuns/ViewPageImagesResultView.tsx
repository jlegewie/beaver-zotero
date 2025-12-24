import React from 'react';
import { PageImageReference } from '../../agents/toolResultTypes';
import ZoteroItemsList, { ZoteroItemReferenceWithLabel } from '../ui/ZoteroItemsList';
import { formatNumberRanges } from '../../utils/stringUtils';

interface ViewPageImagesResultViewProps {
    pages: PageImageReference[];
}

/**
 * Renders the result of a view_page_images tool call.
 * Shows the attachment that was viewed with page information.
 */
export const ViewPageImagesResultView: React.FC<ViewPageImagesResultViewProps> = ({ pages }) => {
    // For display purposes, we show the attachment reference (first page's item)
    // The actual page images are rendered elsewhere in the UI
    if (pages.length === 0) {
        return null;
    }

    // Group page numbers by unique attachment key
    const attachmentMap = new Map<string, { library_id: number; zotero_key: string; pages: number[] }>();
    
    for (const page of pages) {
        const key = `${page.library_id}-${page.zotero_key}`;
        if (!attachmentMap.has(key)) {
            attachmentMap.set(key, {
                library_id: page.library_id,
                zotero_key: page.zotero_key,
                pages: []
            });
        }
        attachmentMap.get(key)!.pages.push(page.page_number);
    }

    const attachments: ZoteroItemReferenceWithLabel[] = Array.from(attachmentMap.values()).map(data => ({
        library_id: data.library_id,
        zotero_key: data.zotero_key,
        label: `Page ${formatNumberRanges(data.pages, ",")}`
    }));

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default ViewPageImagesResultView;

