import { expect, it, vi } from 'vitest';
import { selectLibrary, selectCollection } from '../../../react/utils/selectItem';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

it.each(['library', 'collection'])('reveals a %s in the resolved owner of a borrowed surface', async (kind) => {
    const owner: any = {
        closed: false,
        Zotero_Tabs: { select: vi.fn() },
        ZoteroPane: {
            collectionsView: {
                waitForLoad: vi.fn(async () => {}),
                selectLibrary: vi.fn(async () => true),
                selectCollection: vi.fn(async () => true),
            },
            itemsView: { waitForLoad: vi.fn(async () => {}) },
        },
    };
    const borrowed: any = { closed: false, __beaverOwnerWindowRef: { deref: () => owner } };
    const result = kind === 'library'
        ? await selectLibrary({ libraryID: 1 } as any, borrowed)
        : await selectCollection({ id: 2 } as any, borrowed);
    expect(result).toBe(true);
    expect(owner.Zotero_Tabs.select).toHaveBeenCalledWith('zotero-pane');
});

it("selects Zotero 11's active library tab instead of a fixed tab id", async () => {
    const owner: any = {
        closed: false,
        // A window opened from a reader has no `zotero-pane` tab; selecting it would throw.
        Zotero_Tabs: { select: vi.fn(() => { throw new TypeError('no tab'); }), selectLibraryTab: vi.fn() },
        ZoteroPane: {
            collectionsView: { waitForLoad: vi.fn(async () => {}), selectLibrary: vi.fn(async () => true) },
            itemsView: { waitForLoad: vi.fn(async () => {}) },
        },
    };
    const borrowed: any = { closed: false, __beaverOwnerWindowRef: { deref: () => owner } };
    const result = await selectLibrary({ libraryID: 1 } as any, borrowed);
    expect(result).toBe(true);
    expect(owner.Zotero_Tabs.selectLibraryTab).toHaveBeenCalledTimes(1);
    expect(owner.Zotero_Tabs.select).not.toHaveBeenCalled();
});
