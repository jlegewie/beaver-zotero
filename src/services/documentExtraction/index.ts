export {
    resolveToReadableAttachment,
    resolveToPdfAttachment,
} from './attachmentResolution';
export type {
    ReadableAttachmentResolveResult,
    PdfAttachmentResolveResult,
} from './attachmentResolution';

export {
    checkRemotePdfSize,
    isRemoteAccessAvailable,
    loadPdfData,
} from './pdfData';

export {
    checkAttachmentDataSize,
    loadAttachmentData,
    resolveAttachmentFileSource,
} from './attachmentSource';
export type {
    AttachmentDataResult,
    AttachmentFileSource,
    AttachmentSourceFailureCode,
    AttachmentSourceResult,
    LocalSizeStrategy,
} from './attachmentSource';

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

export { extractTextDocument, TEXT_SCHEMA_VERSION } from './text/extractTextDocument';
export type {
    ZoteroItemReferenceInput,
} from './referenceValidation';
