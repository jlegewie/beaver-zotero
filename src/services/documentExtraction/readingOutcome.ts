import { logger } from '@beaver/agent-core/platform/logger';
import { isLibraryInScope } from '../libraryScope';

/** Document verdicts only: cancellation, worker availability and request limits are not file failures. */
const READING_ERRORS = new Set([
    'file_missing', 'download_failed', 'read_failed', 'file_too_large',
    'encrypted', 'invalid_pdf', 'no_text_layer', 'empty_document',
    'insufficient_text', 'too_many_pages', 'pdf_too_complex', 'extraction_failed',
]);

/** Persist observed readability without claiming pipeline completion or changing remote membership. */
export async function recordReadingOutcome(
    item: { libraryID: number; key: string },
    contentKind: string,
    outcome: { kind: string; code?: string },
    attemptedAt: number,
): Promise<void> {
    if (!isLibraryInScope(item.libraryID)) return;
    if (outcome.kind !== 'ok' && (!outcome.code || !READING_ERRORS.has(outcome.code))) return;
    try {
        await Zotero.Beaver?.db?.recordAttachmentReadingOutcome({
            libraryId: item.libraryID,
            zoteroKey: item.key,
            contentKind,
            errorCode: outcome.kind === 'ok' ? null
                : contentKind === 'pdf' && outcome.code === 'no_text_layer' ? 'ocr_required' : outcome.code!,
            attemptedAt,
        });
    } catch (error) {
        logger(`Could not record attachment reading outcome: ${error}`, 2);
    }
}
