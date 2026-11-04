/**
 * A source-picker search row found only through a field it does not otherwise
 * show (its journal) names that field, so the row explains why it is listed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockItem } from '../../helpers/factories';

vi.mock('../../../react/utils/sourceUtils', () => ({
    getDisplayNameFromItem: () => 'Lovelace 2020',
    isValidZoteroItem: async () => ({ valid: true }),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({ loadFullItemData: vi.fn() }));

import { createSourceMenuItem } from '../../../react/components/ui/menus/utils/menuItemFactories';

const context = { isAttached: () => false, onAdd: vi.fn(), onRemove: vi.fn() };

const row = async (fields: Record<string, string>, query: string) => {
    const item = createMockItem({
        fields: { title: 'Notes on the Engine', date: '2020', ...fields },
        creators: [{ firstName: 'Ada', lastName: 'Lovelace', creatorType: 'author' }],
    }) as any;
    item.getDisplayTitle = () => 'Notes on the Engine';
    item.getItemTypeIconName = () => 'journalArticle';
    const menuItem = await createSourceMenuItem(item, context, query);
    return renderToStaticMarkup(menuItem.customContent as any).replace(/<[^>]+>/g, '');
};

beforeEach(() => {
    (globalThis as any).Zotero = { Utilities: { removeDiacritics: (text: string) => text } };
});

describe('createSourceMenuItem', () => {
    it('names the journal of a row found only through it', async () => {
        expect(await row({ publicationTitle: 'Scientific Memoirs' }, 'memoirs')).toContain('in Scientific Memoirs');
    });

    it('adds nothing to a row found through its title or authors', async () => {
        const text = await row({ publicationTitle: 'Scientific Memoirs' }, 'engine');
        expect(text).not.toContain('Scientific Memoirs');
    });

    it('adds nothing to a row listed without a query', async () => {
        expect(await row({ publicationTitle: 'Scientific Memoirs' }, '')).not.toContain('Scientific Memoirs');
    });
});
