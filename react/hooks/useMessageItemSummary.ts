import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getItemValidationAtom, ItemValidationState } from '../atoms/itemValidation';

export interface InvalidAttachmentInfo {
    item: Zotero.Item;
    reason?: string;
    validation?: ItemValidationState;
}

export interface MessageItemSummary {
    item: Zotero.Item;
    attachments: Zotero.Item[];
    notes: Zotero.Item[];
    validAttachments: Zotero.Item[];
    invalidAttachments: InvalidAttachmentInfo[];
    validAttachmentCount: number;
    invalidAttachmentCount: number;
    hasPDFAttachment: boolean;
    hasIssues: boolean;
}

const safeGetItem = (id: number): Zotero.Item | null => {
    try {
        return Zotero.Items.get(id) || null;
    } catch (error) {
        return null;
    }
};

const isValidPdfAttachment = (attachment: Zotero.Item): boolean => {
    try {
        return typeof attachment.isPDFAttachment === 'function' && attachment.isPDFAttachment();
    } catch (error) {
        return false;
    }
};

export const buildMessageItemSummary = (
    item: Zotero.Item,
    getValidation: (item: Zotero.Item) => ItemValidationState | undefined,
): MessageItemSummary => {
    const attachments: Zotero.Item[] = item && typeof item.isRegularItem === 'function' && item.isRegularItem()
        ? item.getAttachments().map((id: number) => safeGetItem(id)).filter((child): child is Zotero.Item => Boolean(child))
        : item && typeof item.isAttachment === 'function' && item.isAttachment()
            ? [item]
            : [];

    const notes: Zotero.Item[] = item && typeof item.isRegularItem === 'function' && item.isRegularItem()
        ? item.getNotes().map((id: number) => safeGetItem(id)).filter((child): child is Zotero.Item => Boolean(child))
        : item && typeof item.isNote === 'function' && item.isNote()
            ? [item]
            : [];

    const invalidAttachments = attachments
        .map((attachment) => {
            const validation = getValidation(attachment);
            if (validation && !validation.isValid && !validation.isValidating) {
                return {
                    item: attachment,
                    reason: validation.reason,
                    validation,
                } as InvalidAttachmentInfo;
            }
            return null;
        })
        .filter((info): info is InvalidAttachmentInfo => Boolean(info));

    const invalidAttachmentIds = new Set(invalidAttachments.map(({ item: invalidItem }) => invalidItem.id));
    const validAttachments = attachments.filter((attachment) => !invalidAttachmentIds.has(attachment.id));

    const hasPDFAttachment = attachments.some(isValidPdfAttachment);
    const hasIssues = !hasPDFAttachment || invalidAttachments.length > 0;

    return {
        item,
        attachments,
        notes,
        validAttachments,
        invalidAttachments,
        validAttachmentCount: validAttachments.length,
        invalidAttachmentCount: invalidAttachments.length,
        hasPDFAttachment,
        hasIssues,
    };
};

export const useMessageItemSummary = (item: Zotero.Item | null | undefined): MessageItemSummary | null => {
    const getValidation = useAtomValue(getItemValidationAtom);

    return useMemo(() => {
        if (!item) {
            return null;
        }
        return buildMessageItemSummary(item, getValidation);
    }, [item, getValidation]);
};

