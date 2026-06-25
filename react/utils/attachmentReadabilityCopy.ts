import type { ContentKind } from '../../src/services/documentExtraction/shared/contentKinds';
import type { ItemValidationState } from '../atoms/itemValidation';

/**
 * Shared, UI-facing copy for attachment readability across every surface that
 * shows it (the item-added toast, item chip popups, and source-button
 * tooltips). Keeping the wording in one place stops the surfaces from drifting.
 *
 * Two kinds of failure are distinguished, because they need different language:
 *  - Content failure: a supported kind (PDF/EPUB/text/image) that this instance
 *    couldn't read (scanned, encrypted, corrupt, too long, not downloaded). The
 *    copy names the specific reason, since some are actionable.
 *  - Unsupported type: a kind Beaver doesn't handle (snapshot, Word, video, …).
 *    The copy says the attachment kind isn't supported, grouped by kind.
 *
 * This module is pure and React-free so it can be reused by any client.
 */

/** Minimal facts needed to describe why an attachment isn't readable. */
export interface AttachmentReadabilityInfo {
    state: ItemValidationState['state'];
    statusCode?: string | null;
    contentKind?: ContentKind;
    pageCount?: number | null;
    /** True for the item's "best" attachment (usually the main PDF). */
    isPrimary: boolean;
}

/** Plural nouns for unsupported content kinds, used in "Beaver doesn't support …". */
const UNSUPPORTED_KIND_NOUNS: Partial<Record<ContentKind, string>> = {
    snapshot: 'web snapshots',
    linked_url: 'web links',
    word: 'Word documents',
    spreadsheet: 'spreadsheets',
    presentation: 'presentations',
    audio: 'audio files',
    video: 'videos',
    archive: 'archives',
};

/** Kind labels composed into "{Kind} attachments are not supported". */
const UNSUPPORTED_ATTACHMENT_KIND_LABELS: Partial<Record<ContentKind, string>> = {
    snapshot: 'Snapshot',
    linked_url: 'Web link',
    word: 'Word',
    spreadsheet: 'Spreadsheet',
    presentation: 'Presentation',
    audio: 'Audio',
    video: 'Video',
    archive: 'Archive',
};

/** Content kinds whose failure is intrinsic to the file type, not the instance. */
const TYPE_PROBLEM_KINDS: ReadonlySet<string> = new Set([
    'snapshot', 'linked_url', 'word', 'spreadsheet', 'presentation', 'audio', 'video', 'archive', 'other',
]);

/** Convert a Jotai validation state into the minimal readability facts. */
export function toReadabilityInfo(validation: ItemValidationState | undefined): AttachmentReadabilityInfo {
    if (!validation || validation.state === 'checking') {
        return { state: 'checking', isPrimary: false };
    }
    return {
        state: validation.state,
        statusCode: validation.statusCode,
        contentKind: validation.contentKind ?? validation.attachmentInfo?.content_kind,
        pageCount: validation.pageCount ?? validation.attachmentInfo?.page_count,
        isPrimary: validation.attachmentInfo?.is_primary ?? false,
    };
}

function isTypeProblem(info: AttachmentReadabilityInfo): boolean {
    return !!info.contentKind && TYPE_PROBLEM_KINDS.has(info.contentKind);
}

function joinOr(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

function joinAnd(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function unsupportedKindsLabel(kinds: ContentKind[]): string {
    const nouns = Array.from(new Set(kinds.map((k) => UNSUPPORTED_KIND_NOUNS[k] ?? 'these files')));
    return `Beaver doesn't support ${joinOr(nouns)}`;
}

function unsupportedAttachmentsLabel(issues: AttachmentReadabilityInfo[]): string {
    const labels: string[] = [];
    for (const issue of issues) {
        const kind = issue.contentKind;
        if (!kind) return 'Some attachments are not supported';
        const label = UNSUPPORTED_ATTACHMENT_KIND_LABELS[kind];
        if (!label) return 'Some attachments are not supported';
        if (!labels.includes(label)) labels.push(label);
    }
    return `${joinAnd(labels)} attachments are not supported`;
}

/**
 * Summarize unsupported attachment kinds across a set of attachment results.
 */
export function summarizeUnsupportedAttachments(infos: AttachmentReadabilityInfo[]): string {
    const unsupportedIssues = infos.filter(
        (info) => (info.state === 'unreadable' || info.state === 'blocked') && isTypeProblem(info),
    );
    return unsupportedIssues.length > 0 ? unsupportedAttachmentsLabel(unsupportedIssues) : '';
}

/** Short, human reason a single attachment isn't readable. */
export function attachmentIssueLabel(info: AttachmentReadabilityInfo): string {
    switch (info.statusCode) {
        case 'pdf_needs_ocr':
            return 'Scanned PDF — needs a vision model';
        case 'pdf_encrypted':
            return 'PDF is password-protected';
        case 'pdf_invalid':
        case 'pdf_parser_crash':
        case 'pdf_unreadable':
        case 'pdf_analysis_error':
            return "PDF couldn't be read";
        case 'file_too_large':
            return 'File is too large to read';
        case 'file_not_local':
        case 'file_not_local_remote':
            return "File isn't downloaded";
        case 'epub_no_text':
        case 'epub_invalid':
            return "EPUB couldn't be read";
    }

    const kind = info.contentKind;
    // PDFs over the page limit are blocked without a distinctive status code.
    if (kind === 'pdf' && info.pageCount != null) {
        return `PDF is too long (${info.pageCount} pages)`;
    }
    if (kind === 'image') {
        return 'Image needs a vision model';
    }
    if (isTypeProblem(info)) {
        return unsupportedKindsLabel([kind!]);
    }
    return "Couldn't be read";
}

/** Kind adjective composed into "Beaver can't read {X} attachments". */
const KIND_DESCRIPTOR: Partial<Record<ContentKind, string>> = {
    pdf: 'PDF',
    epub: 'EPUB',
    text: 'text',
    image: 'image',
    snapshot: 'snapshot',
    linked_url: 'web link',
    word: 'Word',
    spreadsheet: 'spreadsheet',
    presentation: 'presentation',
    audio: 'audio',
    video: 'video',
    archive: 'archive',
};

/**
 * Kind adjective for the readability message ("scanned PDF", "snapshot", …).
 * The kind is qualified ("scanned PDF") only where that both narrows the problem
 * and reads naturally; otherwise it is the plain kind. Empty when unknown.
 */
function attachmentDescriptor(info: AttachmentReadabilityInfo): string {
    if (info.statusCode === 'pdf_needs_ocr') return 'scanned PDF';
    if (info.statusCode === 'pdf_encrypted') return 'password-protected PDF';
    return (info.contentKind && KIND_DESCRIPTOR[info.contentKind]) || '';
}

export interface RegularItemReadabilitySummary {
    /** True when at least one attachment is readable (the item is usable). */
    usable: boolean;
    readableCount: number;
    totalCount: number;
    /**
     * Attachment-scoped headline shown when at least one attachment can't be
     * read, e.g. "Snapshot attachments are not supported" or "Some scanned PDF
     * attachments can't be read". Empty when every completed attachment is
     * readable, there are no attachments, or validation is still in progress.
     */
    label: string;
}

/**
 * Summarize a regular item's attachment readability into a single headline.
 *
 * The headline is scoped to attachments, not the item: a regular item stays
 * usable (organize, tag, cite) even when some attachment content can't be read,
 * so this must not read as an item-level failure. It is produced whenever a
 * completed attachment has an issue, grouping unsupported attachment kinds
 * before falling back to readability language for supported kinds.
 */
export function summarizeRegularItemReadability(
    infos: AttachmentReadabilityInfo[],
): RegularItemReadabilitySummary {
    const considered = infos.filter((i) => i.state !== 'checking');
    const readableCount = considered.filter((i) => i.state === 'readable').length;
    const issues = considered.filter((i) => i.state === 'unreadable' || i.state === 'blocked');
    const usable = readableCount > 0;
    const totalCount = considered.length;

    let label = '';
    if (issues.length > 0) {
        const unsupportedLabel = summarizeUnsupportedAttachments(issues);
        if (unsupportedLabel && issues.every(isTypeProblem)) {
            return {
                usable,
                readableCount,
                totalCount,
                label: unsupportedLabel,
            };
        }

        const lead = issues.find((i) => i.isPrimary && !isTypeProblem(i))
            ?? issues.find((i) => !isTypeProblem(i))
            ?? issues.find((i) => i.isPrimary)
            ?? issues[0];
        const descriptor = attachmentDescriptor(lead);
        if (usable) {
            label = descriptor
                ? `Some ${descriptor} attachments can't be read`
                : "Some attachments can't be read";
        } else {
            label = descriptor
                ? `Beaver can't read ${descriptor} attachments`
                : "Beaver can't read the attachments";
        }
    }

    return { usable, readableCount, totalCount, label };
}
