export {
    resolveToPdfAttachment,
    resolveToReadableAttachment,
} from './attachmentResolution';
export type {
    PdfAttachmentResolveResult,
    ReadableAttachmentResolveResult,
} from './attachmentResolution';

export {
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    loadPdfData,
} from './pdfData';

export {
    preflightCachedPdfMeta,
} from './preflight';
export type {
    PreflightErrorCode,
    PreflightFailure,
    PreflightOptions,
} from './preflight';

export {
    validateZoteroItemReference,
} from './referenceValidation';
export type {
    ZoteroItemReferenceInput,
} from './referenceValidation';

export {
    extractTextDocument,
    TEXT_SCHEMA_VERSION,
} from './text/extractTextDocument';
export type {
    ExtractTextResult,
} from './text/extractTextDocument';
