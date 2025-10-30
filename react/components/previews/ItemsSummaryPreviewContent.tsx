import React, { useMemo } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { activePreviewAtom } from '../../atoms/ui';
import { getItemValidationAtom } from '../../atoms/itemValidation';
import { buildMessageItemSummary } from '../../hooks/useMessageItemSummary';
import { RegularItemsSummaryContent } from '../ui/popup/RegularItemsSummaryContent';
import IconButton from '../ui/IconButton';
import { CancelIcon } from '../icons/icons';

interface ItemsSummaryPreviewContentProps {
    items: Zotero.Item[];
    maxContentHeight: number;
}

const ItemsSummaryPreviewContent: React.FC<ItemsSummaryPreviewContentProps> = ({ items, maxContentHeight }) => {
    const setActivePreview = useSetAtom(activePreviewAtom);
    const getValidation = useAtomValue(getItemValidationAtom);

    const summaries = useMemo(() => {
        return items.map(item => {
            const summary = buildMessageItemSummary(item, getValidation);
            return {
                item,
                totalAttachments: summary.validAttachmentCount,
                invalidAttachments: summary.invalidAttachmentCount,
            };
        });
    }, [items, getValidation]);

    const headerText = `${items.length} more attachment${items.length === 1 ? '' : 's'}`;

    return (
        <>
            {/* <div className="p-3 display-flex flex-row items-center gap-2 border-bottom-quinary">
                <div className="font-weight-medium font-color-secondary">{headerText}</div>
                <div className="flex-1" />
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={() => setActivePreview(null)}
                    ariaLabel="Close preview"
                />
            </div> */}

            <div
                className="source-content p-3"
                style={{ maxHeight: `${maxContentHeight}px`, overflowY: 'auto' }}
            >
                <RegularItemsSummaryContent items={summaries} />
            </div>
        </>
    );
};

export default ItemsSummaryPreviewContent;
