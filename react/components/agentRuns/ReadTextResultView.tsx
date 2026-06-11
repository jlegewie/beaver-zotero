import React from 'react';
import { LineReference } from '../../agents/toolResultTypes';
import ZoteroItemsList, { ZoteroItemReferenceWithLabel } from '../ui/ZoteroItemsList';

interface ReadTextResultViewProps {
    lines: LineReference[];
}

/**
 * Aggregate line ranges to unique attachments with line range labels.
 */
function aggregateToAttachmentsWithLines(lines: LineReference[]): (ZoteroItemReferenceWithLabel | { library_id: number; zotero_key: string })[] {
    const attachmentMap = new Map<string, { library_id: number; zotero_key: string; ranges: string[] }>();

    for (const range of lines) {
        const key = `${range.library_id}-${range.zotero_key}`;
        if (!attachmentMap.has(key)) {
            attachmentMap.set(key, {
                library_id: range.library_id,
                zotero_key: range.zotero_key,
                ranges: []
            });
        }
        attachmentMap.get(key)!.ranges.push(
            range.start_line === range.end_line
                ? `${range.start_line}`
                : `${range.start_line}-${range.end_line}`
        );
    }

    return Array.from(attachmentMap.values()).map(data => {
        if (data.ranges.length > 0) {
            return {
                library_id: data.library_id,
                zotero_key: data.zotero_key,
                label: `Line${data.ranges.length === 1 && !data.ranges[0].includes('-') ? '' : 's'} ${data.ranges.join(', ')}`
            };
        }
        return {
            library_id: data.library_id,
            zotero_key: data.zotero_key
        };
    });
}

/**
 * Renders the result of the unified `read` tool on text/markdown files.
 * Shows the attachment that was read with line range info.
 */
export const ReadTextResultView: React.FC<ReadTextResultViewProps> = ({ lines }) => {
    const attachments = aggregateToAttachmentsWithLines(lines);

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={attachments} />
        </div>
    );
};

export default ReadTextResultView;
