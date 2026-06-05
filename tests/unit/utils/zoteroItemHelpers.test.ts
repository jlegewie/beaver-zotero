import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockAttachment, createMockItem } from '../../helpers/factories';
import { getBestReadableTextAttachmentAsync } from '../../../src/utils/zoteroItemHelpers';

describe('getBestReadableTextAttachmentAsync', () => {
    const originalItems = (globalThis as any).Zotero.Items;

    afterEach(() => {
        (globalThis as any).Zotero.Items = originalItems;
        vi.restoreAllMocks();
    });

    it('loads parent itemData and falls back to text children when best attachment ranking fails', async () => {
        const textAttachment = createMockAttachment({
            id: 10,
            key: 'TEXT1234',
            contentType: 'text/plain',
        });
        const parent = {
            ...createMockItem({
                id: 100,
                key: 'REG00001',
                attachmentIDs: [textAttachment.id],
            }),
            getBestAttachment: vi.fn(async () => {
                throw new Error('Item data not loaded');
            }),
        };
        const loadDataTypes = vi.fn(async () => undefined);

        (globalThis as any).Zotero.Items = {
            loadDataTypes,
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map((id) => (id === textAttachment.id ? textAttachment : null)).filter(Boolean),
            ),
        };

        const result = await getBestReadableTextAttachmentAsync(parent);

        expect(result).toBe(textAttachment);
        expect(loadDataTypes).toHaveBeenCalledWith([parent], ['childItems', 'itemData']);
        expect(parent.getBestAttachment).toHaveBeenCalledOnce();
    });
});
