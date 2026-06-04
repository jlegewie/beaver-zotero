import { logger } from '../../../utils/logger';
import type { ZoteroDocumentErrorCode } from '../../agentProtocol';
import { effectiveMaxFileSizeMB } from '../../attachmentLimits';
import { isRemoteFilePath, makeRemoteFilePath } from '../../documentFileIdentity';
import type { TextDocumentExtractResult } from '../shared/documentExtractResult';
import {
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    loadPdfData,
} from '../pdfData';
import { isAttachmentAvailableRemotely } from '../../../utils/webAPI';

export const TEXT_SCHEMA_VERSION = '1';

export type ExtractTextResult =
    | {
        kind: 'ok';
        result: TextDocumentExtractResult;
        resolvedAttachment: { libraryId: number; zoteroKey: string };
        contentType: string;
    }
    | {
        kind: 'response_error';
        code: ZoteroDocumentErrorCode;
        message: string;
        resolvedAttachment: { libraryId: number; zoteroKey: string } | null;
    };

function errorResult(
    code: ZoteroDocumentErrorCode,
    message: string,
    item: Zotero.Item | null,
): ExtractTextResult {
    return {
        kind: 'response_error',
        code,
        message,
        resolvedAttachment: item
            ? { libraryId: item.libraryID, zoteroKey: item.key }
            : null,
    };
}

function normalizeText(data: Uint8Array): string {
    const decoded = new TextDecoder('utf-8').decode(data);
    return decoded
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

/**
 * Extract a line-addressable UTF-8 text document from a Zotero attachment.
 */
export async function extractTextDocument(args: {
    item: Zotero.Item;
    requestKey: string;
    contentType: string;
    maxFileSizeMB: number;
    onRemoteDownloadFailure?: (e: unknown) => void;
}): Promise<ExtractTextResult> {
    const { item, requestKey, contentType, onRemoteDownloadFailure } = args;
    const maxFileSizeMB = effectiveMaxFileSizeMB(args.maxFileSizeMB);
    const resolvedAttachment = { libraryId: item.libraryID, zoteroKey: item.key };

    let filePath = await item.getFilePathAsync();
    let isRemoteOnly = false;

    if (!filePath) {
        const isLinkedFile = item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE;
        if (!isLinkedFile && isRemoteAccessAvailable(item)) {
            filePath = makeRemoteFilePath(item);
            isRemoteOnly = true;
        } else {
            const remoteAvailable = !isLinkedFile && isAttachmentAvailableRemotely(item);
            const detail = remoteAvailable
                ? 'The file is available remotely, but remote file access is disabled.'
                : 'The file is not available locally.';
            return errorResult(
                'file_missing',
                `Attachment ${requestKey} file is missing. ${detail}`,
                item,
            );
        }
    } else {
        isRemoteOnly = isRemoteFilePath(filePath);
    }

    if (!isRemoteOnly) {
        try {
            const stat = await IOUtils.stat(filePath);
            const sizeMB = (stat.size ?? 0) / 1024 / 1024;
            if (sizeMB > maxFileSizeMB) {
                return errorResult(
                    'file_too_large',
                    `Attachment ${requestKey} file is too large (${sizeMB.toFixed(1)}MB > ${maxFileSizeMB}MB).`,
                    item,
                );
            }
        } catch (error) {
            logger(`extractTextDocument: IOUtils.stat failed for ${filePath}: ${error}`, 2);
        }
    }

    let bytes: Uint8Array;
    try {
        bytes = await loadPdfData(item, filePath, isRemoteOnly, onRemoteDownloadFailure);
    } catch (error) {
        if (isRemoteOnly) {
            logger(`extractTextDocument: remote download failed for ${requestKey}: ${error}`, 1);
            return errorResult(
                'download_failed',
                `Failed to download attachment ${requestKey} from remote storage.`,
                item,
            );
        }
        logger(`extractTextDocument: local read failed for ${requestKey}: ${error}`, 1);
        return errorResult(
            'extraction_failed',
            `Failed to read text attachment ${requestKey}.`,
            item,
        );
    }

    const remoteSize = checkRemotePdfSize(bytes, false, maxFileSizeMB);
    if (remoteSize) {
        return errorResult(
            'file_too_large',
            `Attachment ${requestKey} file is too large (${remoteSize.sizeMB.toFixed(1)}MB > ${remoteSize.maxMB}MB).`,
            item,
        );
    }

    const text = normalizeText(bytes);
    const lineCount = text === '' ? 0 : text.split('\n').length;

    return {
        kind: 'ok',
        result: {
            content_kind: 'text',
            schemaVersion: TEXT_SCHEMA_VERSION,
            sourceContentType: contentType,
            lineCount,
            text,
        },
        resolvedAttachment,
        contentType,
    };
}
