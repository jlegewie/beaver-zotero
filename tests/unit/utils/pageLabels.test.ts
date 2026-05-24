import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/zoteroItemHelpers', () => ({
    getBestPDFAttachmentAsync: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(),
    isRemoteAccessAvailable: vi.fn(() => false),
}));

import { resolvePageLabelFromLabels } from '../../../react/utils/pageLabels';

describe('pageLabels', () => {
    it('resolves 1-based citation pages against 0-based backend label maps', () => {
        const labels = { 0: 'i', 1: '1', 2: '2' };

        expect(resolvePageLabelFromLabels(labels, 1)).toBe('i');
        expect(resolvePageLabelFromLabels(labels, 2)).toBe('1');
        expect(resolvePageLabelFromLabels(labels, 3)).toBe('2');
    });
});
