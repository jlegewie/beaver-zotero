import React from 'react';
import { CSSItemTypeIcon, NoteIcon, LibraryIcon } from '../icons/icons';
import type { ChipListPopupContent, ChipPopupAction, ChipPopupContent, ChipPopupStatus, ChipPopupSubtitle } from '../agentRuns/requestChips/ChipPopup';
import type { ItemValidationState } from '../../atoms/itemValidation';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import type { AttachmentInfo, ContentKind } from '../../../src/services/documentExtraction/shared/contentKinds';
import {
    toReadabilityInfo,
    attachmentIssueLabel,
    summarizeRegularItemReadability,
} from '../../utils/attachmentReadabilityCopy';

function safeDisplayName(item: Zotero.Item, fallback = 'Item'): string {
    try {
        return getDisplayNameFromItem(item) || item.getDisplayTitle() || fallback;
    } catch {
        try {
            return item.getDisplayTitle() || fallback;
        } catch {
            return fallback;
        }
    }
}

function safeItemTypeIconName(item: Zotero.Item): string {
    try {
        return item.getItemTypeIconName() || 'document';
    } catch {
        return 'document';
    }
}

function attachmentIconName(contentKind?: ContentKind | null): string {
    switch (contentKind) {
        case 'pdf':
            return 'attachmentPDF';
        case 'epub':
            return 'attachmentEPUB';
        case 'snapshot':
            return 'attachmentSnapshot';
        case 'image':
            return 'attachmentImage';
        case 'text':
        default:
            return 'attachmentFile';
    }
}

type ValidationDetails = {
    contentKind?: ContentKind;
    pageCount?: number | null;
    statusCode?: string | null;
    attachmentInfo?: AttachmentInfo;
};

function validationDetails(validation?: ItemValidationState): ValidationDetails {
    if (!validation || validation.state === 'checking') {
        return {};
    }
    return validation;
}

/**
 * Second line of an item chip popup, mirroring the read-only request chips:
 * regular items show their title beneath the creator/year headline; attachments
 * and notes describe their relationship to a parent.
 */
function itemSubtitle(item: Zotero.Item): ChipPopupSubtitle | null {
    try {
        if (item.isAttachment()) {
            const parent = item.parentItem;
            if (parent) {
                return { prefix: 'Attached to ', text: safeDisplayName(parent), italic: true };
            }
            return { text: 'Standalone attachment' };
        }
        if (item.isNote()) {
            return item.parentItem ? { text: 'Attached note' } : { text: 'Standalone note' };
        }
        if (item.isRegularItem()) {
            const firstCreator = item.firstCreator || '';
            const year = item.getField('date')?.match(/\d{4}/)?.[0] || '';
            const creatorYear = [firstCreator, year].filter(Boolean).join(' ');
            const title = item.getField('title') || '';
            // When the headline is the creator/year, surface the title beneath it;
            // when the headline already is the title, there is no second line.
            return creatorYear && title && title !== creatorYear ? { text: title } : null;
        }
    } catch {
        return null;
    }
    return null;
}

function safeChildAttachments(item: Zotero.Item): Zotero.Item[] {
    try {
        if (item.isAttachment()) return [item];
        if (!item.isRegularItem()) return [];
        return item
            .getAttachments()
            .map((id: number) => {
                try {
                    return Zotero.Items.get(id) || null;
                } catch {
                    return null;
                }
            })
            .filter((attachment): attachment is Zotero.Item => Boolean(attachment));
    } catch {
        return [];
    }
}

function itemIconName(item: Zotero.Item, validation?: ItemValidationState): string {
    try {
        if (item.isAttachment()) {
            const details = validationDetails(validation);
            return attachmentIconName(details.contentKind ?? details.attachmentInfo?.content_kind);
        }
    } catch {
        return 'document';
    }
    return safeItemTypeIconName(item);
}

/**
 * Footer affordance describing the chip's primary (left-click) action, mirroring
 * the read-only request chips: notes open in the editor, everything else is
 * revealed in the library.
 */
function itemAction(item: Zotero.Item): ChipPopupAction {
    try {
        if (item.isNote()) {
            return { icon: NoteIcon, label: 'Open note' };
        }
    } catch {
        // Fall through to the default reveal action.
    }
    return { icon: LibraryIcon, label: 'Reveal in library' };
}

/**
 * Readability note for a chip popup, shown only when content can't be read.
 * Regular items aggregate their child attachments (needs `getValidation`);
 * attachments report their own result. Notes and annotations have none.
 */
function readabilityStatus(
    item: Zotero.Item,
    validation: ItemValidationState | undefined,
    getValidation?: (item: Zotero.Item) => ItemValidationState | undefined,
): ChipPopupStatus | null {
    try {
        if (item.isRegularItem()) {
            if (!getValidation) return null;
            const infos = safeChildAttachments(item).map((a) => toReadabilityInfo(getValidation(a)));
            const summary = summarizeRegularItemReadability(infos);
            return summary.label ? { label: summary.label } : null;
        }
        if (item.isAttachment()) {
            const info = toReadabilityInfo(validation);
            if (info.state === 'checking' || info.state === 'readable') return null;
            return { label: attachmentIssueLabel(info) };
        }
    } catch {
        return null;
    }
    return null;
}

export function buildMessageItemChipPopup(
    item: Zotero.Item,
    validation: ItemValidationState | undefined,
    getValidation?: (item: Zotero.Item) => ItemValidationState | undefined,
): ChipPopupContent {
    return {
        icon: <CSSItemTypeIcon itemType={itemIconName(item, validation)} className="scale-90" />,
        title: safeDisplayName(item),
        subtitle: itemSubtitle(item),
        status: readabilityStatus(item, validation, getValidation),
        action: itemAction(item),
    };
}

/** Max item rows listed in the "+N" overflow popup before a summary line. */
const ITEMS_SUMMARY_MAX_ROWS = 4;

/**
 * Popup for the "+N" overflow chip: a plain list of the collapsed items, each
 * rendered like its own chip (icon, display name, subtitle). Listing is capped
 * at {@link ITEMS_SUMMARY_MAX_ROWS}; any further items are summarized in a
 * trailing "N more attachments" line.
 */
export function buildItemsSummaryListPopup(items: Zotero.Item[]): ChipListPopupContent {
    const rows = items.slice(0, ITEMS_SUMMARY_MAX_ROWS).map((item) => ({
        key: item.key,
        icon: <CSSItemTypeIcon itemType={safeItemTypeIconName(item)} className="scale-90" />,
        title: safeDisplayName(item),
        subtitle: itemSubtitle(item),
    }));

    const remaining = items.length - rows.length;
    const footer = remaining > 0
        ? `${remaining} more attachment${remaining === 1 ? '' : 's'}`
        : null;

    return { rows, footer };
}
