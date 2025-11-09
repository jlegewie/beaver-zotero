import React from 'react';
import { InformationCircleIcon } from '../../icons/icons';
import IconButton from '../IconButton';
import { getInfoItemByTitle } from '../../../constants/info';
import { parseTextWithLinksAndNewlines } from '../../../utils/parseTextWithLinksAndNewlines';

interface InvalidItemInfo {
    item: Zotero.Item;
    reason: string;
}

interface InvalidItemsMessageContentProps {
    invalidItems: InvalidItemInfo[];
}

/**
 * Custom popup content for displaying invalid items that were removed
 * Shows unique reasons for removal with count of affected items
 */
export const InvalidItemsMessageContent: React.FC<InvalidItemsMessageContentProps> = ({ invalidItems }) => {
    // Group items by reason to get unique reasons and their counts
    const reasonCounts = invalidItems.reduce((acc, { reason }) => {
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    const uniqueReasons = Object.keys(reasonCounts);

    return (
        <div id="invalid-items-message-content" className="display-flex flex-col gap-3">
            {uniqueReasons.map((reason) => {
                const count = reasonCounts[reason];
                const displayText = count > 1 ? `${reason} (${count} items)` : reason;
                const infoItem = getInfoItemByTitle(reason);

                return (
                    <div key={reason} className="display-flex flex-row items-center gap-1">
                        <div className="font-color-tertiary text-md ml-05">
                            {parseTextWithLinksAndNewlines(displayText)}
                        </div>
                        {infoItem && infoItem.url && (
                            <IconButton
                                icon={InformationCircleIcon}
                                variant="ghost-secondary"
                                className="mb-075"
                                ariaLabel={infoItem.tooltip}
                                title={infoItem.tooltip}
                                onClick={() => {
                                    if (infoItem.url) {
                                        Zotero.launchURL(infoItem.url);
                                    }
                                }}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
};

