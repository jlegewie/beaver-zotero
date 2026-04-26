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

// Normal 15-page PDF
export const NORMAL_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: '2YWA8DTZ',
    description: 'Normal 15-page PDF',
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

// Large 316-page PDF
export const LARGE_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'D4WGZFFX',
    description: '316-page PDF',
};

// Missing local file (attachment exists but file is not available locally)
export const MISSING_FILE_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'SIUWE9HE',
    description: 'PDF attachment with missing local file',
};

// Group library PDF
export const GROUP_LIB_PDF: AttachmentFixture = {
    library_id: 3,
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

// Linked URL attachment
export const LINKED_URL: AttachmentFixture = {
    library_id: 1,
    zotero_key: '8Q98MFN2',
    description: 'Linked URL attachment',
};

// Image attachment (PNG)
export const IMAGE: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'MBWJYPPI',
    description: 'PNG image attachment',
};

// Invalid/corrupted PDF fixture. Override with env var if needed:
//   ZOTERO_INVALID_PDF_REF="1-ABCDEFGH"
export const INVALID_PDF_FIXTURE: AttachmentFixture =
    parseFixtureRef(process.env.ZOTERO_INVALID_PDF_REF, 'Invalid/corrupted PDF') ?? {
        library_id: 1,
        zotero_key: 'XQ6M9NDM',
        description: 'Invalid/corrupted PDF',
    };
