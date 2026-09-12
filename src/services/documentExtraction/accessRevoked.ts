/** Access revocation cancels document work without consuming a job's retry budget. */
export class DocumentAccessRevokedError extends Error {
    readonly code = 'DOCUMENT_ACCESS_REVOKED';

    constructor(message: string) {
        super(message);
        this.name = 'DocumentAccessRevokedError';
    }
}

/** Error constructors differ between the plugin and renderer bundles. */
export function isDocumentAccessRevokedError(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && (error as { code?: unknown }).code === 'DOCUMENT_ACCESS_REVOKED';
}
