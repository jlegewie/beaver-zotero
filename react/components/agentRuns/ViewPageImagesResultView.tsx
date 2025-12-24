import React from 'react';
import { PageImageReference } from '../../agents/toolResultTypes';
import ZoteroItemsList from '../ui/ZoteroItemsList';

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

    // Get unique attachments (in case multiple pages from same attachment)
    const uniqueAttachments = pages.reduce((acc, page) => {
        const key = `${page.library_id}-${page.zotero_key}`;
        if (!acc.has(key)) {
            acc.set(key, {
                library_id: page.library_id,
                zotero_key: page.zotero_key,
            });
        }
        return acc;
    }, new Map());

    const attachments = Array.from(uniqueAttachments.values());

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default ViewPageImagesResultView;

