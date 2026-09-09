import { describe, expect, it } from 'vitest';
import {
    classifyProcessingIssue,
    groupProcessingIssues,
    type AttachmentProcessingIssueRow,
} from '../../../src/services/backgroundProcessing/issues';

function row(overrides: Partial<AttachmentProcessingIssueRow>): AttachmentProcessingIssueRow {
    return {
        libraryId: 1,
        zoteroKey: 'AAAAAAAA',
        extractStatus: null,
        ocrStatus: null,
        upsertStatus: null,
        lastError: null,
        updatedAt: '2026-09-09 10:00:00',
        ...overrides,
    };
}

const noOcr = { hasOcrAccess: false, hasSearchIndexAccess: false };
const withOcr = { hasOcrAccess: true, hasSearchIndexAccess: true };

describe('classifyProcessingIssue', () => {
    it('maps availability codes to "file not available" in every recorded shape', () => {
        for (const error of ['file_missing', 'download_failed: 404', 'ocr load: read_failed']) {
            expect(classifyProcessingIssue(row({ extractStatus: 'skipped', lastError: error }), noOcr))
                .toBe('file_unavailable');
        }
    });

    it('recognises encrypted, oversized and unsupported files', () => {
        expect(classifyProcessingIssue(row({ extractStatus: 'skipped', lastError: 'encrypted' }), noOcr)).toBe('encrypted');
        expect(classifyProcessingIssue(row({ extractStatus: 'skipped', lastError: 'too_many_pages' }), noOcr)).toBe('too_large');
        expect(classifyProcessingIssue(row({ extractStatus: 'failed', lastError: 'file_too_large: 120MB' }), noOcr)).toBe('too_large');
        expect(classifyProcessingIssue(row({ extractStatus: 'failed', lastError: 'unsupported_type' }), noOcr)).toBe('unsupported');
    });

    it('puts text-less files with scans when OCR is not available, and apart when it is', () => {
        const empty = row({ extractStatus: 'failed', lastError: 'empty_document' });
        expect(classifyProcessingIssue(empty, noOcr)).toBe('scanned');
        expect(classifyProcessingIssue(empty, withOcr)).toBe('no_text');
    });

    it('treats a scan waiting for OCR as an issue only without OCR access', () => {
        const needed = row({ extractStatus: 'done', ocrStatus: 'needed' });
        expect(classifyProcessingIssue(needed, noOcr)).toBe('scanned');
        expect(classifyProcessingIssue(needed, withOcr)).toBeNull();
    });

    it('reports downstream failures after successful extraction', () => {
        expect(classifyProcessingIssue(row({ extractStatus: 'done', ocrStatus: 'failed' }), withOcr)).toBe('ocr_failed');
        expect(classifyProcessingIssue(row({ extractStatus: 'done', ocrStatus: 'done', upsertStatus: 'failed' }), withOcr)).toBe('index_failed');
    });

    it.each(['failed', 'skipped'])('prioritizes %s extraction over stale downstream failures', (extractStatus) => {
        for (const entitlements of [noOcr, withOcr]) {
            expect(classifyProcessingIssue(row({
                extractStatus, ocrStatus: 'failed', upsertStatus: 'failed', lastError: 'file_missing',
            }), entitlements)).toBe('file_unavailable');
        }
    });

    it('falls back to a generic extraction error for unknown codes', () => {
        expect(classifyProcessingIssue(row({ extractStatus: 'failed', lastError: 'extraction_failed: boom' }), noOcr)).toBe('extract_failed');
        expect(classifyProcessingIssue(row({ extractStatus: 'failed', lastError: null }), noOcr)).toBe('extract_failed');
    });

    it('ignores rows that are still healthy', () => {
        expect(classifyProcessingIssue(row({ extractStatus: 'done', ocrStatus: 'na' }), noOcr)).toBeNull();
        expect(classifyProcessingIssue(row({ extractStatus: null }), noOcr)).toBeNull();
    });
});

describe('groupProcessingIssues', () => {
    it('ignores cleanup and unknown job types instead of reporting unreadable files', () => {
        const dead = ['fulltext_untag', 'future_cleanup', 'document_extract'].map((jobType, index) => ({
            jobType, libraryId: 1, zoteroKey: `FILE000${index}`, lastError: 'timeout', diedAt: 1,
        }));
        const groups = groupProcessingIssues([], dead, withOcr);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({ reason: 'extract_failed', count: 1 });
        expect(groups[0].items[0].zoteroKey).toBe('FILE0002');
    });
    it('hides index-only issues without search access while retaining extraction failures', () => {
        const rows = [
            row({ zoteroKey: 'INDEX000', extractStatus: 'done', upsertStatus: 'failed' }),
            row({ zoteroKey: 'BOTH0000', extractStatus: 'failed', upsertStatus: 'failed' }),
        ];
        const dead = [{ jobType: 'fulltext_upsert', libraryId: 1, zoteroKey: 'DEAD0000', lastError: 'timeout', diedAt: 1 }];
        expect(groupProcessingIssues(rows, dead, withOcr).map((group) => [group.reason, group.count]))
            .toEqual([['extract_failed', 1], ['index_failed', 2]]);
        expect(groupProcessingIssues(rows, dead, noOcr).map((group) => [group.reason, group.count]))
            .toEqual([['extract_failed', 1]]);
    });
    it('groups by reason in display order with the newest file first', () => {
        const groups = groupProcessingIssues([
            row({ zoteroKey: 'OLD00000', extractStatus: 'skipped', lastError: 'file_missing', updatedAt: '2026-09-01 00:00:00' }),
            row({ zoteroKey: 'ENC00000', extractStatus: 'skipped', lastError: 'encrypted' }),
            row({ zoteroKey: 'NEW00000', extractStatus: 'skipped', lastError: 'download_failed', updatedAt: '2026-09-08 00:00:00' }),
        ], [], noOcr);
        expect(groups.map((group) => [group.reason, group.count])).toEqual([
            ['file_unavailable', 2],
            ['encrypted', 1],
        ]);
        expect(groups[0].items.map((item) => item.zoteroKey)).toEqual(['NEW00000', 'OLD00000']);
    });

    it('drops a dead letter whose attachment already has a ledger issue', () => {
        const groups = groupProcessingIssues(
            [row({ zoteroKey: 'SAME0000', extractStatus: 'failed', lastError: 'extraction_failed' })],
            [{ jobType: 'document_extract', libraryId: 1, zoteroKey: 'SAME0000', lastError: 'timeout', diedAt: 1 }],
            noOcr,
        );
        expect(groups).toHaveLength(1);
        expect(groups[0].count).toBe(1);
    });

    it('files a lone dead letter under the stage its job type implies', () => {
        const groups = groupProcessingIssues([], [
            { jobType: 'fulltext_upsert', libraryId: 1, zoteroKey: 'UPS00000', lastError: 'http 500', diedAt: 2 },
            { jobType: 'document_ocr', libraryId: 1, zoteroKey: 'OCR00000', lastError: null, diedAt: 1 },
        ], withOcr);
        expect(groups.map((group) => group.reason)).toEqual(['ocr_failed', 'index_failed']);
    });
});
