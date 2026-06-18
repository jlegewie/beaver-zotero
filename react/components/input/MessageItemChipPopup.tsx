import React from 'react';
import { CSSItemTypeIcon, Icon, AlertCircleIcon, InformationCircleIcon, MoreHorizontalIcon } from '../icons/icons';
import type { ChipPopupContent, ChipPopupSubtitle } from '../agentRuns/requestChips/ChipPopup';
import type { ItemValidationState } from '../../atoms/itemValidation';
import { isHardBlockedValidation } from '../../atoms/itemValidation';
import { getDisplayNameFromItem } from '../../utils/sourceUtils';
import type { AttachmentInfo, ContentKind } from '../../../src/services/documentExtraction/shared/contentKinds';

const CONTENT_KIND_LABELS: Partial<Record<ContentKind, string>> = {
    pdf: 'PDF',
    epub: 'EPUB',
    text: 'Text file',
    image: 'Image',
    snapshot: 'Snapshot',
    word: 'Word document',
    spreadsheet: 'Spreadsheet',
    presentation: 'Presentation',
    audio: 'Audio',
    video: 'Video',
    archive: 'Archive',
    linked_url: 'Linked URL',
    other: 'File',
};

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

export type UnvalidatedAttachmentState = 'checking' | 'readable';

function validationDetails(validation?: ItemValidationState): ValidationDetails {
    if (!validation || validation.state === 'checking') {
        return {};
    }
    return validation;
}

function attachmentLabel(validation?: ItemValidationState): string {
    const details = validationDetails(validation);
    const contentKind = details.contentKind ?? details.attachmentInfo?.content_kind;
    return contentKind ? (CONTENT_KIND_LABELS[contentKind] ?? 'File') : 'Attachment';
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

function parentSubtitle(item: Zotero.Item): ChipPopupSubtitle | null {
    try {
        const parent = item.parentItem;
        if (!parent) return null;
        return { prefix: 'Attached to ', text: safeDisplayName(parent), italic: true };
    } catch {
        return null;
    }
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

function attachmentHint(item: Zotero.Item, validation?: ItemValidationState): string {
    const details = validationDetails(validation);

    if (validation?.isValidating) {
        return 'Checking readability';
    }
    if (validation?.state === 'blocked') {
        return validation.reason || 'Unavailable to Beaver';
    }
    if (details.statusCode === 'pdf_needs_ocr') {
        return 'Scanned PDF - no text layer';
    }
    if (validation?.state === 'unreadable') {
        return validation.reason || `${attachmentLabel(validation)} is not readable`;
    }

    const label = attachmentLabel(validation);
    if (details.contentKind === 'pdf' && typeof details.pageCount === 'number') {
        return `${label} - ${plural(details.pageCount, 'page')}`;
    }
    if (details.contentKind === 'epub' && typeof details.pageCount === 'number') {
        return `${label} - ${plural(details.pageCount, 'section')}`;
    }
    if (details.contentKind === 'text' && typeof details.attachmentInfo?.line_count === 'number') {
        return `${label} - ${plural(details.attachmentInfo.line_count, 'line')}`;
    }
    if (details.contentKind === 'image') {
        return 'Image - Beaver will view it';
    }
    if (details.contentKind === 'snapshot') {
        return 'Snapshot - web page text';
    }

    try {
        if (item.isAttachment()) return `${label} attached`;
    } catch {
        return 'Attachment attached';
    }
    return 'Attachment attached';
}

function itemHint(
    item: Zotero.Item,
    validation: ItemValidationState | undefined,
    getValidation: (item: Zotero.Item) => ItemValidationState | undefined,
    unvalidatedAttachmentState: UnvalidatedAttachmentState,
): string {
    try {
        if (item.isAttachment()) {
            return attachmentHint(item, validation);
        }
        if (item.isNote()) {
            return 'Note content attached';
        }
        if (!item.isRegularItem()) {
            return validation?.reason || 'Item attached';
        }
    } catch {
        return validation?.reason || 'Item attached';
    }

    if (validation?.isValidating) {
        return 'Checking attachment readability';
    }

    const attachments = safeChildAttachments(item);
    if (attachments.length === 0) {
        return 'Metadata only - no file attachments';
    }

    let readable = 0;
    let checking = 0;
    for (const attachment of attachments) {
        const attachmentValidation = getValidation(attachment);
        if (!attachmentValidation) {
            if (unvalidatedAttachmentState === 'checking') {
                checking += 1;
            } else {
                readable += 1;
            }
        } else if (attachmentValidation.isValidating) {
            checking += 1;
        } else if (attachmentValidation.state === 'readable') {
            readable += 1;
        }
    }

    if (checking > 0) {
        return `Checking ${plural(checking, 'attachment')}`;
    }
    return `${readable}/${attachments.length} attachments readable`;
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

export function buildMessageItemChipPopup(
    item: Zotero.Item,
    validation: ItemValidationState | undefined,
    getValidation: (item: Zotero.Item) => ItemValidationState | undefined,
    options: { unvalidatedAttachmentState?: UnvalidatedAttachmentState } = {},
): ChipPopupContent {
    const title = safeDisplayName(item);
    const hint = itemHint(
        item,
        validation,
        getValidation,
        options.unvalidatedAttachmentState ?? 'checking',
    );
    const hasStrongIssue = isHardBlockedValidation(validation);

    return {
        icon: <CSSItemTypeIcon itemType={itemIconName(item, validation)} className="scale-90" />,
        title,
        subtitle: parentSubtitle(item),
        action: {
            icon: hasStrongIssue ? AlertCircleIcon : InformationCircleIcon,
            label: hint,
            iconClassName: hasStrongIssue ? '' : 'scale-95',
        },
    };
}

export function buildItemsSummaryChipPopup(
    items: Zotero.Item[],
    getValidation: (item: Zotero.Item) => ItemValidationState | undefined,
    options: { unvalidatedAttachmentState?: UnvalidatedAttachmentState } = {},
): ChipPopupContent {
    const attachments = items.flatMap(safeChildAttachments);
    let readable = 0;
    let checking = 0;
    const unvalidatedAttachmentState = options.unvalidatedAttachmentState ?? 'checking';

    for (const attachment of attachments) {
        const validation = getValidation(attachment);
        if (!validation) {
            if (unvalidatedAttachmentState === 'checking') {
                checking += 1;
            } else {
                readable += 1;
            }
        } else if (validation.isValidating) {
            checking += 1;
        } else if (validation.state === 'readable') {
            readable += 1;
        }
    }

    const label = attachments.length === 0
        ? 'No file attachments'
        : checking > 0
            ? `Checking ${plural(checking, 'attachment')}`
            : `${readable}/${attachments.length} attachments readable`;

    return {
        icon: <Icon icon={MoreHorizontalIcon} className="font-color-secondary" />,
        title: `${items.length} more ${items.length === 1 ? 'item' : 'items'}`,
        subtitle: { text: `${attachments.length} file ${attachments.length === 1 ? 'attachment' : 'attachments'}` },
        action: {
            icon: InformationCircleIcon,
            label,
            iconClassName: 'scale-95',
        },
    };
}
