/**
 * The double-click guard, requirement by requirement.
 *
 * The behaviour under test is almost entirely "what did *not* happen": Zotero's
 * own handler ran, exactly once, and nothing of Beaver's opened. So every test
 * asserts both sides — the call count on the original and the call count on
 * `openTable` — rather than only the happy path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPref = vi.hoisted(() => vi.fn());
const openTable = vi.hoisted(() => vi.fn());
const canOpenTable = vi.hoisted(() => vi.fn());
const isTableItem = vi.hoisted(() => vi.fn());
const loadTableItemFields = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/prefs', () => ({
    getPref,
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

vi.mock('../../../src/ui/openTable', () => ({
    openTable,
    canOpenTable,
    resolveTableTarget: vi.fn(() => 'tab'),
}));

vi.mock('../../../src/services/artifacts/tableItemIdentity', () => ({
    isTableItem,
    loadTableItemFields,
    TABLE_TAG: 'beaver-table',
}));

import {
    cleanupTableDoubleClick,
    installTableDoubleClick,
    isTableDoubleClickInstalled,
    lastTableDoubleClick,
    uninstallTableDoubleClick,
    warmTableItems,
    whenTableDoubleClickSettles,
} from '../../../src/ui/tableDoubleClick';

interface FakeItem {
    id: number;
    key: string;
    libraryID: number;
}

const TABLE: FakeItem = { id: 42, key: 'TABLEKEY', libraryID: 1 };
const PDF: FakeItem = { id: 43, key: 'PDFKEY', libraryID: 1 };

let pane: any;
let win: Window;
let originalViewItems: ReturnType<typeof vi.fn>;
let originalViewAttachment: ReturnType<typeof vi.fn>;

function makeWindow(): void {
    originalViewItems = vi.fn().mockResolvedValue(undefined);
    originalViewAttachment = vi.fn().mockResolvedValue(undefined);
    pane = { viewItems: originalViewItems, viewAttachment: originalViewAttachment };
    win = { ZoteroPane: pane } as unknown as Window;
}

/** Puts an item into the pre-warmed cache the synchronous decision reads. */
async function warm(item: FakeItem): Promise<void> {
    await warmTableItems([item as unknown as Zotero.Item]);
}

beforeEach(async () => {
    vi.clearAllMocks();
    cleanupTableDoubleClick();
    makeWindow();

    getPref.mockReturnValue(true);
    canOpenTable.mockReturnValue(true);
    openTable.mockResolvedValue({ opened: 'tab' });
    loadTableItemFields.mockResolvedValue(undefined);
    isTableItem.mockImplementation((item: FakeItem) => item?.id === TABLE.id);
    (Zotero as any).getMainWindow = vi.fn(() => win);
    (Zotero as any).Items = { get: vi.fn(), getAsync: vi.fn() };
    (Zotero as any).Notifier = {
        registerObserver: vi.fn(() => 'observer-1'),
        unregisterObserver: vi.fn(),
    };
});

describe('installing and restoring (requirements 1 and 7)', () => {
    it('captures the original once per window and wraps both handlers', () => {
        installTableDoubleClick(win);

        expect(pane.viewItems).not.toBe(originalViewItems);
        expect(pane.viewAttachment).not.toBe(originalViewAttachment);
        expect(isTableDoubleClickInstalled(win)).toBe(true);

        // Re-installing replaces rather than chains: the original underneath is
        // still Zotero's, not the previous wrapper.
        const firstWrapper = pane.viewItems;
        installTableDoubleClick(win);
        expect(pane.viewItems).not.toBe(firstWrapper);

        uninstallTableDoubleClick(win);
        expect(pane.viewItems).toBe(originalViewItems);
        expect(pane.viewAttachment).toBe(originalViewAttachment);
    });

    it('does not wrap a handler that is not a function', () => {
        pane.viewAttachment = undefined;

        installTableDoubleClick(win);

        expect(pane.viewItems).not.toBe(originalViewItems);
        expect(pane.viewAttachment).toBeUndefined();
    });

    it('does not wrap at all when neither handler is a function', () => {
        pane.viewItems = null;
        pane.viewAttachment = null;

        installTableDoubleClick(win);

        expect(pane.viewItems).toBeNull();
        expect(isTableDoubleClickInstalled(win)).toBe(false);
    });

    it('leaves a slot alone when someone else wrapped after us', () => {
        installTableDoubleClick(win);
        const foreign = vi.fn();
        pane.viewItems = foreign;

        uninstallTableDoubleClick(win);

        // Restoring here would silently drop the other wrapper.
        expect(pane.viewItems).toBe(foreign);
        // The untouched slot is still restored.
        expect(pane.viewAttachment).toBe(originalViewAttachment);
    });

    it('restores every window on shutdown', () => {
        installTableDoubleClick(win);
        const other = { ZoteroPane: { viewItems: vi.fn(), viewAttachment: vi.fn() } };
        const otherOriginal = other.ZoteroPane.viewItems;
        installTableDoubleClick(other as unknown as Window);

        cleanupTableDoubleClick();

        expect(pane.viewItems).toBe(originalViewItems);
        expect(other.ZoteroPane.viewItems).toBe(otherOriginal);
    });
});

describe('falling through (requirements 3, 4, 5 and 6)', () => {
    beforeEach(() => installTableDoubleClick(win));

    it('hands a normal PDF to Zotero, exactly once, and opens nothing', async () => {
        await warm(PDF);

        await pane.viewItems([PDF], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(originalViewItems).toHaveBeenCalledWith([PDF], null);
        expect(openTable).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.path).toBe('original');
        expect(lastTableDoubleClick()?.reason).toBe('not_a_table');
    });

    it('hands a multi-selection to Zotero even when one of them is a table', async () => {
        await warm(TABLE);
        await warm(PDF);

        await pane.viewItems([TABLE, PDF], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.reason).toBe('not_single_item');
    });

    it('hands an item whose data is not yet loaded to Zotero, and warms it', async () => {
        (Zotero as any).Items.getAsync = vi.fn().mockResolvedValue([TABLE]);

        await pane.viewItems([TABLE], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.reason).toBe('not_warm');

        // Having been warmed, the next click is answerable.
        await vi.waitFor(() => expect(Zotero.Items.getAsync).toHaveBeenCalled());
        await pane.viewItems([TABLE], null);
        expect(openTable).toHaveBeenCalledTimes(1);
    });

    it('hands the click back when no table surface is available', async () => {
        await warm(TABLE);
        canOpenTable.mockReturnValue(false);

        await pane.viewItems([TABLE], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.reason).toBe('no_surface');
    });

    it('hands every click back while the preference is off', async () => {
        await warm(TABLE);
        getPref.mockReturnValue(false);

        await pane.viewItems([TABLE], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.reason).toBe('disabled');
    });

    it('hands the click back when the preference cannot be read', async () => {
        await warm(TABLE);
        getPref.mockImplementation(() => {
            throw new Error('prefs unavailable');
        });

        await pane.viewItems([TABLE], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
    });
});

describe('throwing (requirement 2)', () => {
    beforeEach(() => installTableDoubleClick(win));

    it('runs the original exactly once when the decision throws', async () => {
        await warm(TABLE);
        isTableItem.mockImplementation(() => {
            throw new Error('item data not loaded');
        });

        await pane.viewItems([TABLE], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.reason).toBe('threw');
    });

    it('runs the original exactly once when reading an argument throws', async () => {
        const poisoned = {
            get id() {
                throw new Error('dead wrapper');
            },
        };

        await pane.viewItems([poisoned], null);

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
    });

    it('does not swallow an error thrown by Zotero itself', async () => {
        originalViewItems.mockRejectedValue(new Error('zotero failed'));

        await expect(pane.viewItems([PDF], null)).rejects.toThrow('zotero failed');
        expect(originalViewItems).toHaveBeenCalledTimes(1);
    });
});

describe('taking the click (requirement 5)', () => {
    beforeEach(() => installTableDoubleClick(win));

    it('opens the table and never also runs Zotero', async () => {
        await warm(TABLE);

        await pane.viewItems([TABLE], null);
        await whenTableDoubleClickSettles();

        expect(openTable).toHaveBeenCalledTimes(1);
        expect(openTable).toHaveBeenCalledWith(
            { libraryID: TABLE.libraryID, key: TABLE.key },
            { win }
        );
        expect(originalViewItems).not.toHaveBeenCalled();
        expect(originalViewAttachment).not.toHaveBeenCalled();

        const record = lastTableDoubleClick();
        expect(record?.path).toBe('beaver');
        expect(record?.opened).toBe('tab');
    });

    it('records a failed open without falling back to Zotero after the fact', async () => {
        await warm(TABLE);
        openTable.mockResolvedValue({ error: 'nothing could open it' });

        await pane.viewItems([TABLE], null);
        await whenTableDoubleClickSettles();

        expect(originalViewItems).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.error).toBe('nothing could open it');
    });

    it('takes the click through viewAttachment too, resolving the item id', async () => {
        await warm(TABLE);
        (Zotero as any).Items.get = vi.fn(() => TABLE);

        await pane.viewAttachment(TABLE.id, null);
        await whenTableDoubleClickSettles();

        expect(openTable).toHaveBeenCalledTimes(1);
        expect(originalViewAttachment).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.handler).toBe('viewAttachment');
    });

    it('does not re-examine the nested viewAttachment call Zotero makes itself', async () => {
        // A fall-through that reaches Zotero's viewItems, which delegates to
        // this.viewAttachment for the same (table) item. Beaver must not take
        // over there: the original has already been entered.
        (Zotero as any).Items.get = vi.fn(() => TABLE);
        // Both warmed, so the nested call would otherwise be intercepted — the
        // re-entry guard is the only thing stopping it.
        await warm(TABLE);
        await warm(PDF);
        originalViewItems.mockImplementation(async function (this: any) {
            await this.viewAttachment(TABLE.id, null);
        });

        await pane.viewItems([PDF], null);
        await whenTableDoubleClickSettles();

        expect(originalViewItems).toHaveBeenCalledTimes(1);
        expect(originalViewAttachment).toHaveBeenCalledTimes(1);
        expect(openTable).not.toHaveBeenCalled();
        expect(lastTableDoubleClick()?.reason).toBe('reentrant');
    });

    it('intercepts that same viewAttachment call when it is not nested', async () => {
        (Zotero as any).Items.get = vi.fn(() => TABLE);
        await warm(TABLE);

        await pane.viewAttachment(TABLE.id, null);
        await whenTableDoubleClickSettles();

        expect(openTable).toHaveBeenCalledTimes(1);
        expect(originalViewAttachment).not.toHaveBeenCalled();
    });
});
