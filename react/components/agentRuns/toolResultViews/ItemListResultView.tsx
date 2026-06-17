import React, { useState } from 'react';
import { CSSItemTypeIcon } from '../../icons/icons';
import { truncateText } from '../../../utils/stringUtils';
import { itemTypeToIconName, ContentKind } from '../../../types/citations';
import {
    ItemListView,
    ItemRowView,
    isItemRow,
} from '../../../types/toolResultViews';
import { getHost } from '../../../host';
import { AnnotationResultRow } from './AnnotationResultRow';

/**
 * Shared renderer for hydrated item and annotation rows.
 */

/** Right-aligned labels are capped so they never crowd out the primary text. */
const LABEL_MAX_LENGTH = 24;

function revealRow(libraryId: number, zoteroKey: string): void {
    getHost().navigation?.revealInLibrary({ library_id: libraryId, zotero_key: zoteroKey });
}

interface RowEventProps {
    isHovered: boolean;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
}

const ItemRow: React.FC<{ row: ItemRowView } & RowEventProps> = ({
    row,
    isHovered,
    onMouseEnter,
    onMouseLeave,
}) => {
    const iconType = itemTypeToIconName(
        row.item_type ?? undefined,
        (row.content_kind ?? undefined) as ContentKind | undefined,
    );
    const faded = row.status === 'error';
    const hasSecondLine = Boolean(row.subtitle) || Boolean(row.attachment_label);

    return (
        <div
            className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''} ${faded ? 'opacity-50' : ''}`}
            onClick={() => revealRow(row.library_id, row.zotero_key)}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            title="Click to reveal in Zotero"
        >
            <span className="scale-90 p-1" style={{ marginTop: '-5px' }}>
                <CSSItemTypeIcon itemType={iconType} />
            </span>
            <div className="display-flex flex-col flex-1 gap-1 min-w-0 font-color-primary">
                <div className="display-flex flex-row gap-1 min-w-0 font-color-primary">
                    <div className="truncate text-sm font-color-primary">
                        {row.display_name}
                    </div>
                    {row.location_label && (
                        <>
                            <div className="flex-1" />
                            <div className="text-sm font-color-tertiary mr-1" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                                {truncateText(row.location_label, LABEL_MAX_LENGTH)}
                            </div>
                        </>
                    )}
                </div>
                {hasSecondLine && (
                    <div className="display-flex flex-row gap-1 min-w-0">
                        {row.subtitle && (
                            <div className="truncate text-sm font-color-secondary">
                                {row.subtitle}
                            </div>
                        )}
                        {row.attachment_label && (
                            <>
                                <div className="flex-1" />
                                <div className="text-sm font-color-tertiary mr-1" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                                    {truncateText(row.attachment_label, LABEL_MAX_LENGTH)}
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export const ItemListResultView: React.FC<{ view: ItemListView }> = ({ view }) => {
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    if (view.items.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No items found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col min-w-0">
            {view.items.map((row, index) => {
                const key = `${row.kind}-${row.library_id}-${row.zotero_key}-${index}`;
                const rowEvents: RowEventProps = {
                    isHovered: hoveredKey === key,
                    onMouseEnter: () => setHoveredKey(key),
                    onMouseLeave: () => setHoveredKey(null),
                };
                return isItemRow(row) ? (
                    <ItemRow key={key} row={row} {...rowEvents} />
                ) : (
                    <AnnotationResultRow key={key} row={row} variant="with-parent" {...rowEvents} />
                );
            })}
        </div>
    );
};

export default ItemListResultView;
