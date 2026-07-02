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
import { EXTERNAL_LIBRARY_ID } from '../../../../src/services/externalFiles';
import { AnnotationResultRow } from './AnnotationResultRow';

/**
 * Shared renderer for hydrated item and annotation rows.
 *
 * Each item row pairs its item-type icon (in a rounded tile) with a two-line
 * title/subtitle block; clicking reveals the item in the host library. Rows are
 * separated by a hairline divider.
 */

/** Right-aligned labels are capped so they never crowd out the primary text. */
const LABEL_MAX_LENGTH = 24;

/**
 * Activate an item row through the host. External-file rows (`library_id ===
 * EXTERNAL_LIBRARY_ID`, `zotero_key` holding the ext key) open the local copy in
 * the OS viewer; every other row reveals the item in the library pane. Both host
 * methods surface a warning popup when the target is gone — a missing local copy
 * or a deleted library item — so the render layer only routes by the row's
 * hydrated library identity.
 */
function activateRow(row: ItemRowView): void {
    if (row.library_id === EXTERNAL_LIBRARY_ID) {
        getHost().navigation?.launchExternalFile(row.zotero_key);
        return;
    }
    getHost().navigation?.revealInLibrary({ library_id: row.library_id, zotero_key: row.zotero_key });
}

/**
 * The second line of an item row, split so only the parent bibliographic
 * identity is italicized.
 *
 * `prefix` (e.g. "Attached to ") renders in normal style; `text` is the body.
 * `italic` is true only when `text` is parent-item information ("Smith 2004.
 * Title"), so the relationship prefix and the standalone/external labels stay
 * upright.
 */
interface RowSubtitle {
    prefix: string | null;
    text: string;
    italic: boolean;
}

/**
 * Build the second-line content for an item row.
 *
 * Child-item rows whose headline is the item itself — attachment-headline (A)
 * rows (`item_type === "attachment"` with no `attachment_label`, so
 * `display_name` is the file's own name) and note (N) rows — describe their
 * parent relationship on the second line: "Attached to <parent bib>" when a
 * parent subtitle is present (the parent bib italicized), else a "Standalone …"
 * / "External file" label when there is none. Every other row (regular items,
 * and parent-centric (P) attachment rows that already headline the parent and
 * carry an `attachment_label`) renders `subtitle` as-is.
 */
function rowSubtitle(row: ItemRowView): RowSubtitle | null {
    const isAttachmentHeadline = row.item_type === 'attachment' && !row.attachment_label;
    const isNote = row.item_type === 'note';
    if (!isAttachmentHeadline && !isNote) {
        return row.subtitle ? { prefix: null, text: row.subtitle, italic: false } : null;
    }
    if (row.subtitle) return { prefix: 'Attached to ', text: row.subtitle, italic: true };
    if (isNote) return { prefix: null, text: 'Standalone note', italic: false };
    const label = row.library_id === EXTERNAL_LIBRARY_ID ? 'External file' : 'Standalone attachment';
    return { prefix: null, text: label, italic: false };
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
    const subtitle = rowSubtitle(row);
    const hasSecondLine = Boolean(subtitle) || Boolean(row.attachment_label);
    const isExternal = row.library_id === EXTERNAL_LIBRARY_ID;

    return (
        <div
            className={`display-flex flex-row items-start gap-25 p-2 cursor-pointer transition-colors ${isHovered ? 'bg-quinary' : ''} ${faded ? 'opacity-50' : ''}`}
            onClick={() => activateRow(row)}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            title={isExternal ? 'Click to open the file' : 'Click to reveal in Zotero'}
        >
            <div
                className="display-flex items-center justify-center flex-shrink-0 rounded-md ml-05 mt-010"
            >
                <CSSItemTypeIcon itemType={iconType} className="scale-90" />
            </div>
            <div className="display-flex flex-col flex-1 gap-05 min-w-0 font-color-primary">
                <div className="display-flex flex-row items-center gap-2 min-w-0">
                    <div className="truncate font-color-primary" style={{ fontSize: '0.925rem' }}>
                        {row.display_name}
                    </div>
                    {row.location_label && row.content_kind !== 'snapshot' && (
                        <>
                            <div className="flex-1" />
                            <div className="text-sm font-color-tertiary" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                                {truncateText(row.location_label, LABEL_MAX_LENGTH)}
                            </div>
                        </>
                    )}
                </div>
                {hasSecondLine && (
                    <div className="display-flex flex-row items-center gap-2 min-w-0">
                        {subtitle && (
                            <div className="truncate text-sm font-color-secondary">
                                {subtitle.prefix}
                                {subtitle.italic ? (
                                    <span className="font-italic">{subtitle.text}</span>
                                ) : (
                                    subtitle.text
                                )}
                            </div>
                        )}
                        {/* {row.attachment_label && (
                            <>
                                <div className="flex-1" />
                                <div className="text-sm font-color-tertiary" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                                    {truncateText(row.attachment_label, LABEL_MAX_LENGTH)}
                                </div>
                            </>
                        )} */}
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
                const isLast = index === view.items.length - 1;
                return (
                    <div key={key} className={isLast ? '' : 'border-bottom-quinary'}>
                        {isItemRow(row) ? (
                            <ItemRow row={row} {...rowEvents} />
                        ) : (
                            <AnnotationResultRow row={row} variant="with-parent" {...rowEvents} />
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default ItemListResultView;
