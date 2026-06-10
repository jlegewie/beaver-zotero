/**
 * Shared test fixture definitions.
 *
 * Contains Zotero port/URL config and attachment fixtures used by both
 * live and integration tests.
 */

// Candidate ports probed by `isZoteroAvailable()`. The env var (if set) wins;
// otherwise we try Zotero 7's default (23119) and the Zotero 10 beta default
// (23124). The first port that answers `/beaver/test/ping` becomes the
// resolved port for the rest of the run.
const ENV_PORT = process.env.ZOTERO_HTTP_PORT
    ? parseInt(process.env.ZOTERO_HTTP_PORT, 10)
    : null;
export const ZOTERO_PORT_CANDIDATES: number[] = Array.from(
    new Set(
        [ENV_PORT, 23119, 23124].filter(
            (p): p is number => typeof p === 'number' && Number.isFinite(p),
        ),
    ),
);

let resolvedPort: number = ZOTERO_PORT_CANDIDATES[0] ?? 23119;

export function setZoteroPort(port: number): void {
    resolvedPort = port;
}

export function getBaseUrl(): string {
    return `http://127.0.0.1:${resolvedPort}`;
}

export interface AttachmentFixture {
    library_id: number;
    zotero_key: string;
    description: string;
}

function parseFixtureRef(
    ref: string | undefined,
    description: string,
): AttachmentFixture | null {
    if (!ref) return null;
    const clean = ref.trim();
    const dash = clean.indexOf('-');
    if (dash <= 0) return null;
    const libraryId = parseInt(clean.slice(0, dash), 10);
    const zoteroKey = clean.slice(dash + 1);
    if (!Number.isFinite(libraryId) || libraryId < 1 || !zoteroKey) return null;
    return {
        library_id: libraryId,
        zotero_key: zoteroKey,
        description,
    };
}

// Normal 18-page PDF
export const NORMAL_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: '2YWA8DTZ',
    description: 'Normal 18-page PDF',
};

// Small 2-page PDF
export const SMALL_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'G7TTJKFH',
    description: '2-page PDF',
};

// Password-protected PDF
export const ENCRYPTED_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'JAU8YTBD',
    description: 'Encrypted PDF',
};

// Scanned PDF without text layer
export const NO_TEXT_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'NV37VILU',
    description: 'No text layer (scanned)',
};

// Large 373-page PDF
export const LARGE_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'D4WGZFFX',
    description: '373-page PDF',
};

// Missing local file (attachment exists but file is not available locally)
export const MISSING_FILE_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'SIUWE9HE',
    description: 'PDF attachment with missing local file',
};

// Group library PDF
export const GROUP_LIB_PDF: AttachmentFixture = {
    library_id: 2,
    zotero_key: 'WTY4J27Q',
    description: 'Group library PDF (11 pages)',
};

// Another group library PDF
export const GROUP_LIB2_PDF: AttachmentFixture = {
    library_id: 3,
    zotero_key: 'ZY9ZUTKA',
    description: 'Group library 2 PDF',
};

// Parent item (regular item, not attachment) — should auto-resolve
export const PARENT_ITEM: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'IYI5SMYM',
    description: 'Parent item (auto-resolves to attachment)',
};

// Non-PDF attachment (EPUB)
export const NON_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'ZRKSCH67',
    description: 'EPUB attachment',
};

// EPUB attachment that has a parent regular item (NON_PDF is top-level)
export const EPUB_WITH_PARENT: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'RPZR45JZ',
    description: 'EPUB attachment with parent item',
};

// Regular item (book) whose only child is the EPUB_WITH_PARENT attachment.
export const EPUB_PARENT_ITEM: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'AIH32E72',
    description: 'Regular item with a single EPUB child',
};

// Genuine linked-URL attachment (LINK_MODE_LINKED_URL) — no stored file.
export const LINKED_URL: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'LRHNLZ6Z',
    description: 'Linked URL attachment',
};

// Image attachment (PNG)
export const IMAGE: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'MBWJYPPI',
    description: 'PNG image attachment',
};

// Plain-text attachment (text/plain) — readable kind 'text'.
export const TEXT_ATTACHMENT: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'ATNC86U2',
    description: 'text/plain attachment',
};

// Web-snapshot attachment (text/html) — readable kind 'snapshot' (group library).
export const SNAPSHOT_ATTACHMENT: AttachmentFixture = {
    library_id: 3,
    zotero_key: '46GA3WJK',
    description: 'HTML snapshot attachment (group library)',
};

// Unreadable attachment (application/octet-stream) — no readable kind.
export const UNREADABLE_ATTACHMENT: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'H8HK5HFR',
    description: 'Unreadable octet-stream attachment',
};

// Regular item: one text child + one PDF child — resolver prefers the PDF.
export const PARENT_PDF_AND_TEXT: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'RXWQK2UC',
    description: 'Regular item with a PDF and a text child (PDF preferred)',
};

// Regular item whose only readable child is an HTML snapshot (group library).
export const PARENT_SNAPSHOT_ONLY: AttachmentFixture = {
    library_id: 3,
    zotero_key: '3HQUPSES',
    description: 'Regular item with a single snapshot child (group library)',
};

// Regular item with many readable children whose best attachment is a PDF.
export const PARENT_MANY_READABLE: AttachmentFixture = {
    library_id: 1,
    zotero_key: '5P7G8HSC',
    description: 'Regular item with many readable children (best is a PDF)',
};

// Regular item whose only child is a linked-URL attachment (not readable).
export const PARENT_LINKED_URL_ONLY: AttachmentFixture = {
    library_id: 1,
    zotero_key: '47I39QFV',
    description: 'Regular item with only a linked-URL child',
};

// Invalid/corrupted PDF fixture. Override with env var if needed:
//   ZOTERO_INVALID_PDF_REF="1-ABCDEFGH"
export const INVALID_PDF_FIXTURE: AttachmentFixture =
    parseFixtureRef(process.env.ZOTERO_INVALID_PDF_REF, 'Invalid/corrupted PDF') ?? {
        library_id: 1,
        zotero_key: 'XQ6M9NDM',
        description: 'Invalid/corrupted PDF',
    };
