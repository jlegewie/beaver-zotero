import React from 'react';
import { CSSItemTypeIcon, Icon, InformationCircleIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { ANNOTATION_ICON_BY_TYPE, ANNOTATION_TEXT_BY_TYPE } from '../../../utils/annotationDisplay';
import { toAnnotation } from '../../../types/attachments/converters';
import { getDisplayNameFromItem } from '../../../utils/sourceUtils';
import { truncateText } from '../../../utils/stringUtils';

/**
 * Icon for a row in the items summary preview.
 */
function ItemSummaryIcon({ item }: { item: Zotero.Item }) {
    if (item.isAnnotation()) {
        const annotation = toAnnotation(item);
        const icon = annotation?.annotation_type
            ? ANNOTATION_ICON_BY_TYPE[annotation.annotation_type] || ZOTERO_ICONS.ANNOTATION
            : ZOTERO_ICONS.ANNOTATION;
        return <ZoteroIcon icon={icon} size={14} className="mt-1"/>;
    }

    const itemType = item.getItemTypeIconName();
    return (
        <span className="scale-80">
            <CSSItemTypeIcon itemType={itemType} />
        </span>
    );
}

/**
 * Display label for a row in the items summary preview.
 */
function getItemSummaryDisplayName(item: Zotero.Item): string {
    if (item.isAnnotation()) {
        const annotation = toAnnotation(item);
        if (annotation?.annotation_type) {
            return ANNOTATION_TEXT_BY_TYPE[annotation.annotation_type] || 'Annotation';
        }
        return 'Annotation';
    }
    if (item.isRegularItem()) {
        return truncateText(getDisplayNameFromItem(item), 50);
    }
    return item.getDisplayTitle();
}

interface RegularItemReadabilityRow {
    item: Zotero.Item;
    /** Pre-computed, attachment-scoped readability note (empty when none). */
    label: string;
}

/**
 * Neutral readability note line. The wording is scoped to the attachment and
 * the tone is informational (not an error): the item itself is still usable.
 */
function StatusLine({ label, icon = true }: { label: string; icon?: boolean }) {
    if (!label) return null;
    return (
        <div className="display-flex flex-row items-start font-color-secondary gap-1 text-md">
            {icon && <Icon icon={InformationCircleIcon} className="scale-11 font-color-secondary flex-shrink-0 mt-020" />}
            <span>{label}</span>
        </div>
    );
}

interface RegularItemsSummaryContentProps {
    items: RegularItemReadabilityRow[];
    /**
     * Whether to render each item's icon + title.
     * For the single-item popup the header already shows the item, so this is
     * false and only the readability line is rendered. For the multi-item
     * summary the header is just a count, so each item's icon + title is listed.
     */
    showItemTitles?: boolean;
    /** Whether to show the status icon before readability text. */
    showStatusIcon?: boolean;
}

/**
 * Summary content showing attachment readability for one or more regular items.
 */
export const RegularItemsSummaryContent: React.FC<RegularItemsSummaryContentProps> = ({
    items,
    showItemTitles = true,
    showStatusIcon = true,
}) => {
    // Single-item popup: the header already shows the item's icon + title, so
    // render only the readability line.
    if (!showItemTitles) {
        return (
            <div className="display-flex flex-col gap-15">
                {items.map((row) => (
                    <StatusLine key={row.item.key} label={row.label} icon={showStatusIcon} />
                ))}
            </div>
        );
    }

    // Multi-item summary: the header is just a count, so list each item with its
    // icon + title and readability line.
    return (
        <div className="display-flex flex-col gap-15">
            {items.map((row) => (
                <div key={row.item.key} className="display-flex flex-col gap-2">
                    <div className="display-flex items-start gap-1">
                        <div className="flex-shrink-0 -mt-010">
                            <ItemSummaryIcon item={row.item} />
                        </div>
                        <div className="flex-1 min-w-0 font-color-secondary truncate">
                            {getItemSummaryDisplayName(row.item)}
                        </div>
                    </div>
                    <div className="ml-15">
                        <StatusLine label={row.label} icon={showStatusIcon} />
                    </div>
                </div>
            ))}
        </div>
    );
};
