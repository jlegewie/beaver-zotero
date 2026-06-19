import { logger } from '../utils/logger';
import { getAttachmentInfo } from './documentExtraction/attachmentInfo';
import {
    prepareAttachmentInfoBatchData,
    processAttachmentInfoBatch,
} from './documentExtraction/attachmentInfoBatch';
import type { AttachmentInfo, ContentKind } from './documentExtraction/shared/contentKinds';
import { effectiveMaxPageCount } from './attachmentLimits';

export type ItemValidationResultState = 'readable' | 'unreadable' | 'blocked';
export type ItemValidationSeverity = 'info' | 'error';

/**
 * Result of item validation.
 */
export interface ItemValidationResult {
    state: ItemValidationResultState;
    severity?: ItemValidationSeverity;
    reason?: string;
    statusCode?: string | null;
    contentKind?: ContentKind;
    pageCount?: number | null;
    attachmentInfo?: AttachmentInfo;
}

/**
 * Result of validating a single attachment within a regular item.
 */
export type AttachmentValidationResult = ItemValidationResult;

/**
 * Result of validating a regular item with all its attachments.
 */
export interface RegularItemValidationResult extends ItemValidationResult {
    attachmentResults: Map<string, AttachmentValidationResult>;
}

/**
 * Options for validation.
 */
export interface ItemValidationOptions {
    searchableLibraryIds?: number[];
    supportsVision?: boolean;
    canHandleOCRLocally?: boolean;
}

type BasicValidationResult = Pick<ItemValidationResult, 'state' | 'reason'>;

function attachmentId(item: Zotero.Item): string {
    return `${item.libraryID}-${item.key}`;
}

function readableResult(overrides: Partial<ItemValidationResult> = {}): ItemValidationResult {
    return {
        state: 'readable',
        ...overrides,
    };
}

function unreadableResult(
    reason: string | undefined,
    overrides: Partial<ItemValidationResult> = {},
    severity: ItemValidationSeverity = 'error',
): ItemValidationResult {
    return {
        state: 'unreadable',
        severity,
        reason,
        ...overrides,
    };
}

function blockedResult(reason: string, overrides: Partial<ItemValidationResult> = {}): ItemValidationResult {
    return {
        state: 'blocked',
        severity: 'error',
        reason,
        ...overrides,
    };
}

function reasonFromAttachmentInfo(info: AttachmentInfo): string | undefined {
    if (info.status_reason) {
        return info.status_reason;
    }
    if (info.status_code === 'file_not_local_remote') {
        return 'File not available locally and remote file access is disabled in settings.';
    }
    if (info.status_code === 'file_not_local') {
        return 'File is not available locally';
    }
    if (info.status_code === 'file_too_large') {
        return info.status_reason || 'File exceeds the maximum readable size.';
    }
    if (info.status_code === 'pdf_encrypted') {
        return 'PDF is password-protected';
    }
    if (info.status_code === 'pdf_invalid') {
        return 'PDF file is invalid or corrupted';
    }
    if (info.status_code === 'pdf_needs_ocr') {
        return 'PDF requires OCR (no text layer). Select a model with vision support or enabled Plus Tools.';
    }
    if (info.status_code === 'pdf_parser_crash') {
        return 'PDF crashes the local PDF parser';
    }
    if (info.status_code === 'pdf_analysis_error') {
        return 'Error analyzing PDF';
    }
    if (info.status_code === 'pdf_unreadable') {
        return 'PDF could not be read';
    }
    if (info.status_code === 'epub_invalid') {
        return 'EPUB could not be read by the local extractor';
    }
    if (info.status_code === 'epub_no_text') {
        return 'EPUB contains no extractable text';
    }
    return info.status === 'unreadable' ? 'Attachment is not readable by Beaver' : undefined;
}

export function resultFromAttachmentInfo(
    info: AttachmentInfo,
    options: ItemValidationOptions = {},
): ItemValidationResult {
    const base = {
        statusCode: info.status_code,
        contentKind: info.content_kind,
        pageCount: info.page_count,
        attachmentInfo: info,
    };
    if (info.content_kind === 'pdf' && info.page_count != null) {
        const maxPageCount = effectiveMaxPageCount();
        if (info.page_count > maxPageCount) {
            return blockedResult(
                `PDF has ${info.page_count} pages, which exceeds the ${maxPageCount}-page limit.`,
                base,
            );
        }
    }
    if (
        info.status_code === 'file_not_local'
        || info.status_code === 'file_not_local_remote'
        || info.status_code === 'file_too_large'
    ) {
        return blockedResult(reasonFromAttachmentInfo(info) || 'Attachment is not available to Beaver', base);
    }
    if (info.content_kind === 'image' && !options.supportsVision) {
        return blockedResult('Images require a model with vision support.', base);
    }
    if (info.status_code === 'pdf_needs_ocr' && options.canHandleOCRLocally) {
        return readableResult({
            ...base,
            reason: reasonFromAttachmentInfo(info),
        });
    }
    if (info.status_code === 'pdf_needs_ocr') {
        return blockedResult(reasonFromAttachmentInfo(info) || 'PDF requires OCR (no text layer). Select a model with vision support or enabled Plus Tools.', base);
    }
    if (info.status_code === 'epub_no_text') {
        return blockedResult(reasonFromAttachmentInfo(info) || 'EPUB contains no extractable text', base);
    }
    if (info.status === 'readable' || info.status === 'processing') {
        return readableResult(base);
    }
    const severity: ItemValidationSeverity =
        info.status_code === 'pdf_needs_ocr'
            ? 'info'
            : 'error';
    return unreadableResult(reasonFromAttachmentInfo(info), base, severity);
}

/**
 * Manages item validation and deduplicates concurrent validation requests.
 */
class ItemValidationManager {
    private pendingValidations = new Map<string, Promise<ItemValidationResult>>();

    /**
     * Check whether an item's library can be used in Beaver.
     */
    private checkLibrarySearchable(
        item: Zotero.Item,
        searchableLibraryIds?: number[],
    ): BasicValidationResult {
        const library = Zotero.Libraries.get(item.libraryID);
        if (!library) {
            return blockedResult('Library not found');
        }

        if (searchableLibraryIds && !searchableLibraryIds.includes(item.libraryID)) {
            return blockedResult(
                `Library "${library.name}" is excluded from Beaver. You can update this setting in Beaver Preferences.`,
            );
        }

        return readableResult();
    }

    /**
     * Validate cheap item-level constraints that do not require file analysis.
     */
    private validateItemShell(
        item: Zotero.Item,
        options: ItemValidationOptions,
    ): BasicValidationResult {
        const libraryCheck = this.checkLibrarySearchable(item, options.searchableLibraryIds);
        if (libraryCheck.state === 'blocked') {
            return libraryCheck;
        }

        if (item.isRegularItem()) {
            return item.isInTrash()
                ? blockedResult('Item is in trash')
                : readableResult();
        }

        if (item.isAttachment()) {
            return item.isInTrash()
                ? blockedResult('Attachment is in trash')
                : readableResult();
        }

        if (item.isAnnotation()) {
            const validTypes = ['highlight', 'underline', 'note', 'image'];
            if (!validTypes.includes(item.annotationType)) {
                return blockedResult('Invalid annotation type');
            }
            if (
                (item.annotationType === 'highlight' || item.annotationType === 'underline')
                && !item.annotationText
                && !item.annotationComment
            ) {
                return blockedResult('Annotation is empty');
            }
            const parent = item.parentItem;
            if (!parent || !parent.isAttachment()) {
                return blockedResult('Parent item is not an attachment');
            }
            return readableResult();
        }

        if (item.isNote()) {
            return item.isInTrash()
                ? blockedResult('Note is in trash')
                : readableResult();
        }

        return blockedResult('Invalid item type');
    }

    /**
     * Main validation method for one Zotero item.
     */
    async validateItem(
        item: Zotero.Item,
        options: ItemValidationOptions = {},
    ): Promise<ItemValidationResult> {
        const cacheKey = attachmentId(item);

        if (this.pendingValidations.has(cacheKey)) {
            logger(`ItemValidationManager: Returning pending validation for ${cacheKey}`, 4);
            return this.pendingValidations.get(cacheKey)!;
        }

        const validationPromise = this.performValidation(item, options);
        this.pendingValidations.set(cacheKey, validationPromise);

        try {
            return await validationPromise;
        } finally {
            this.pendingValidations.delete(cacheKey);
        }
    }

    /**
     * Validate an item using cheap item checks plus unified attachment info.
     */
    private async performValidation(
        item: Zotero.Item,
        options: ItemValidationOptions,
    ): Promise<ItemValidationResult> {
        try {
            logger(`ItemValidationManager: Starting validation for ${attachmentId(item)}`, 4);
            const shellValidation = this.validateItemShell(item, options);
            if (shellValidation.state === 'blocked') {
                return shellValidation;
            }

            if (!item.isAttachment()) {
                return readableResult();
            }

            const info = await getAttachmentInfo(item, {
                nonPdfReadableEnabled: true,
            });
            return resultFromAttachmentInfo(info, options);
        } catch (error: any) {
            logger(`ItemValidationManager: Validation failed for ${attachmentId(item)}: ${error.message}`, 1);
            return blockedResult('Unexpected validation error');
        }
    }

    /**
     * Validate a regular item and all child attachments with unified attachment info.
     */
    async validateRegularItem(
        item: Zotero.Item,
        options: ItemValidationOptions = {},
    ): Promise<RegularItemValidationResult> {
        if (!item.isRegularItem()) {
            throw new Error('validateRegularItem can only be called on regular items');
        }

        logger(`ItemValidationManager: Starting validation for regular item ${attachmentId(item)}`, 4);
        const itemValidation = this.validateItemShell(item, options);
        if (itemValidation.state === 'blocked') {
            return {
                ...itemValidation,
                attachmentResults: new Map(),
            };
        }

        const attachmentIDs = item.getAttachments();
        if (attachmentIDs.length === 0) {
            return {
                ...readableResult(),
                attachmentResults: new Map(),
            };
        }

        const batchData = await prepareAttachmentInfoBatchData([item]);
        const attachmentInfos = await processAttachmentInfoBatch(item, batchData, {
            nonPdfReadableEnabled: true,
        });

        const attachmentResults = new Map<string, AttachmentValidationResult>();
        for (const info of attachmentInfos) {
            attachmentResults.set(info.attachment_id, resultFromAttachmentInfo(info, options));
        }

        logger(
            `ItemValidationManager: Regular item validation complete. Attachments processed: ${attachmentResults.size}`,
            4,
        );

        return {
            ...readableResult(),
            attachmentResults,
        };
    }

}

export const itemValidationManager = new ItemValidationManager();
