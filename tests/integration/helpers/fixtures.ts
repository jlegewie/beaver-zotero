/**
 * Test fixture definitions for integration tests.
 *
 * Each fixture references a real attachment in the test Zotero library.
 * The Zotero HTTP port is configurable via ZOTERO_HTTP_PORT env var.
 */

export const ZOTERO_PORT = parseInt(process.env.ZOTERO_HTTP_PORT || '23119', 10);
export const BASE_URL = `http://127.0.0.1:${ZOTERO_PORT}`;

export interface AttachmentFixture {
    library_id: number;
    zotero_key: string;
    description: string;
}

// Normal 15-page PDF
export const NORMAL_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'QEB4INKW',
    description: 'Normal 15-page PDF',
};

// Small 2-page PDF
export const SMALL_PDF: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'E5GP8455',
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
    zotero_key: 'SKZIZVMT',
    description: '316-page PDF',
};

// Group library PDF
export const GROUP_LIB_PDF: AttachmentFixture = {
    library_id: 3,
    zotero_key: '2UXUSC8M',
    description: 'Group library PDF (38 pages)',
};

// Another group library PDF
export const GROUP_LIB2_PDF: AttachmentFixture = {
    library_id: 2,
    zotero_key: '5YTGTKGL',
    description: 'Group library 2 PDF',
};

// Parent item (regular item, not attachment) — should auto-resolve
export const PARENT_ITEM: AttachmentFixture = {
    library_id: 1,
    zotero_key: 'YDNNR2UB',
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
    zotero_key: 'K3XGEA2S',
    description: 'PNG image attachment',
};
