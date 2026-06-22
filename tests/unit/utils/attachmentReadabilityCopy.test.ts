import { describe, expect, it } from 'vitest';
import {
    summarizeRegularItemReadability,
    summarizeUnsupportedAttachments,
    toReadabilityInfo,
    type AttachmentReadabilityInfo,
} from '../../../react/utils/attachmentReadabilityCopy';

function info(overrides: Partial<AttachmentReadabilityInfo>): AttachmentReadabilityInfo {
    return {
        state: 'readable',
        isPrimary: false,
        ...overrides,
    };
}

describe('attachmentReadabilityCopy', () => {
    describe('toReadabilityInfo', () => {
        it('falls back to attachment metadata for the content kind', () => {
            const info = toReadabilityInfo({
                state: 'unreadable',
                isValidating: false,
                attachmentInfo: {
                    content_kind: 'word',
                    page_count: null,
                    is_primary: false,
                },
            } as Parameters<typeof toReadabilityInfo>[0]);

            expect(info.contentKind).toBe('word');
        });
    });

    describe('summarizeRegularItemReadability', () => {
        it('surfaces an attachment issue even when another attachment is readable', () => {
            const summary = summarizeRegularItemReadability([
                info({ state: 'readable', contentKind: 'pdf', isPrimary: true }),
                info({ state: 'unreadable', contentKind: 'snapshot' }),
            ]);

            expect(summary.usable).toBe(true);
            expect(summary.readableCount).toBe(1);
            expect(summary.totalCount).toBe(2);
            expect(summary.label).toBe('Snapshot attachments are not supported');
        });

        it('aggregates multiple unsupported attachment kinds', () => {
            const summary = summarizeRegularItemReadability([
                info({ state: 'readable', contentKind: 'pdf', isPrimary: true }),
                info({ state: 'unreadable', contentKind: 'snapshot' }),
                info({ state: 'blocked', contentKind: 'word' }),
                info({ state: 'blocked', contentKind: 'spreadsheet' }),
            ]);

            expect(summary.usable).toBe(true);
            expect(summary.label).toBe('Snapshot, Word and Spreadsheet attachments are not supported');
        });

        it('uses generic unsupported copy when unsupported kinds cannot be named', () => {
            const summary = summarizeRegularItemReadability([
                info({ state: 'readable', contentKind: 'pdf', isPrimary: true }),
                info({ state: 'blocked', contentKind: 'other' }),
            ]);

            expect(summary.usable).toBe(true);
            expect(summary.label).toBe('Some attachments are not supported');
        });

        it('uses readability copy for supported attachment kinds', () => {
            const summary = summarizeRegularItemReadability([
                info({ state: 'readable', contentKind: 'pdf', isPrimary: true }),
                info({ state: 'blocked', contentKind: 'image' }),
            ]);

            expect(summary.usable).toBe(true);
            expect(summary.label).toBe("Some image attachments can't be read");
        });

        it('omits the issue label when completed attachments are readable', () => {
            const summary = summarizeRegularItemReadability([
                info({ state: 'readable', contentKind: 'pdf', isPrimary: true }),
                info({ state: 'checking', contentKind: 'snapshot' }),
            ]);

            expect(summary.usable).toBe(true);
            expect(summary.readableCount).toBe(1);
            expect(summary.totalCount).toBe(1);
            expect(summary.label).toBe('');
        });
    });

    describe('summarizeUnsupportedAttachments', () => {
        it('aggregates unsupported attachment kinds and ignores readable attachments', () => {
            const summary = summarizeUnsupportedAttachments([
                info({ state: 'readable', contentKind: 'pdf' }),
                info({ state: 'blocked', contentKind: 'snapshot' }),
                info({ state: 'unreadable', contentKind: 'word' }),
            ]);

            expect(summary).toBe('Snapshot and Word attachments are not supported');
        });

        it('ignores supported attachment readability failures', () => {
            const summary = summarizeUnsupportedAttachments([
                info({ state: 'blocked', contentKind: 'image' }),
                info({ state: 'unreadable', contentKind: 'pdf' }),
            ]);

            expect(summary).toBe('');
        });
    });
});
