import React from 'react';
import { ItemExtractionReference } from '../../agents/toolResultTypes';
import ZoteroItemsList, { ZoteroItemReferenceWithLabel } from '../ui/ZoteroItemsList';

interface ExtractResultViewProps {
    items: ItemExtractionReference[];
}

const STATUS_LABELS: Record<string, string> = {
    relevant: 'Relevant',
    not_relevant: 'Not relevant',
    error: 'Error',
};

/**
 * Renders the result of the extract tool.
 * Shows each item with a status label (Relevant / Not relevant / Error).
 */
export const ExtractResultView: React.FC<ExtractResultViewProps> = ({ items }) => {
    const attachments: ZoteroItemReferenceWithLabel[] = items.map(item => ({
        library_id: item.library_id,
        zotero_key: item.zotero_key,
        label: STATUS_LABELS[item.status] ?? item.status,
        faded: item.status !== 'relevant',
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
