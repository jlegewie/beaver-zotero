import React from 'react';
import { ItemExtractionReference } from '../../agents/toolResultTypes';
import ZoteroItemsList, { ZoteroItemReferenceWithLabel } from '../ui/ZoteroItemsList';

interface ExtractResultViewProps {
    items: ItemExtractionReference[];
}

// "success" is the current status; "relevant"/"not_relevant" are legacy
// values still found in older thread history.
const STATUS_LABELS: Record<string, string> = {
    success: '',
    not_relevant: '',
    relevant: '',
    error: 'Error',
};

/**
 * Renders the result of the extract tool.
 * Shows each item with a status label (successful extraction / Error).
 */
export const ExtractResultView: React.FC<ExtractResultViewProps> = ({ items }) => {
    const attachments: ZoteroItemReferenceWithLabel[] = items.map(item => ({
        library_id: item.library_id,
        zotero_key: item.zotero_key,
        label: STATUS_LABELS[item.status] ?? item.status,
        // Fade failed (and legacy not-relevant) items; successful extractions
        // are shown normally.
        faded: item.status === 'error' || item.status === 'not_relevant',
    }));

    if (attachments.length === 0) {
        return <div className="font-color-tertiary text-sm px-15 py-15">No items processed</div>;
    }

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default ExtractResultView;
