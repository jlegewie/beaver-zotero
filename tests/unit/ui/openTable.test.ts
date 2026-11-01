/**
 * `openTable`: the one way a stored table gets on screen — the Beaver tab.
 *
 * What is tested is the contract around the tab: which window it opens in,
 * that it opens before the store's repair (which waits on the table's lock)
 * and shows what the repair reports, that a table with nothing to read opens
 * nothing, and that nothing throws, because every caller is a UI path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveTableItem = vi.hoisted(() => vi.fn());
const readTableItemSpec = vi.hoisted(() => vi.fn());
const snapshotIsCurrent = vi.hoisted(() => vi.fn());
const contextMainWindow = vi.hoisted(() => vi.fn());
const resolveNavigationWindow = vi.hoisted(() => vi.fn());
const canHostTableTab = vi.hoisted(() => vi.fn(() => true));
const openTableTab = vi.hoisted(() => vi.fn());
const setTableTabWarning = vi.hoisted(() => vi.fn());
const restoreCheck = vi.hoisted(() => vi.fn(async () => 'ok'));
const tableRepairAllowed = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/services/artifacts/tableItemIdentity', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../src/services/artifacts/tableItemIdentity')>();
    return {
        UNREADABLE_TABLE_RECOVERY: original.UNREADABLE_TABLE_RECOVERY,
        TABLE_REPAIR_SKIPPED: original.TABLE_REPAIR_SKIPPED,
        tableRepairAllowed,
        unreadableTableRecovery: original.unreadableTableRecovery,
        resolveTableItem,
        readTableItemSpec,
    };
});
vi.mock('../../../src/services/artifacts/tablesApi', () => ({
    getTablesApi: () => ({ shadow: { check: restoreCheck } }),
}));
vi.mock('../../../src/services/artifacts/tableRenderer', () => ({ snapshotIsCurrent }));
vi.mock('../../../src/ui/tableTab', () => ({ canHostTableTab, openTableTab, setTableTabWarning }));
vi.mock('../../../src/runtime/navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/runtime/navigation')>()),
    contextMainWindow,
    resolveNavigationWindow,
}));

import { openTable } from '../../../src/ui/openTable';
import { WindowUnavailableError } from '../../../src/runtime/navigation';

const REF = { libraryID: 1, key: 'TABLEKEY' };
const SPEC = { id: 't', key: REF.key, version: 4, title: 'Spec', columns: [], rows: [] };
const ITEM = { id: 42, key: REF.key, libraryID: REF.libraryID };

const main = { closed: false, __beaverRuntime: { status: 'ready' } } as any;
const other = { closed: false, __beaverRuntime: { status: 'ready' } } as any;
let run: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    resolveTableItem.mockResolvedValue(ITEM);
    readTableItemSpec.mockResolvedValue({ ok: true, spec: SPEC, file: { spec: SPEC } });
    snapshotIsCurrent.mockResolvedValue(true);
    tableRepairAllowed.mockReturnValue(true);
    contextMainWindow.mockImplementation((origin: any) => (origin === main || origin?.context === main ? main : null));
    resolveNavigationWindow.mockImplementation(async (origin?: any) => origin ?? other);
    openTableTab.mockReturnValue({ tabID: 'tab-1', reused: false });
    run = vi.fn().mockResolvedValue({ recovered: [], sha256: 'a'.repeat(64) });
    (Zotero as any).Beaver = { ...(Zotero as any).Beaver, libraryOperations: { run } };
    (Zotero as any).Promise = { delay: vi.fn(async () => {}) };
});

describe('openTable', () => {
    it("opens the Beaver tab in the origin's main window with the spec it read", async () => {
        await expect(openTable(REF, { window: main })).resolves.toEqual({ ok: true, tabID: 'tab-1', reused: false });
        expect(resolveNavigationWindow).toHaveBeenCalledWith(main);
        expect(openTableTab).toHaveBeenCalledWith(main, ITEM, REF, {
            initial: { spec: SPEC, version: 4 },
            background: undefined,
            index: undefined,
        });
    });

    it('opens in the main window a standalone window follows', async () => {
        const standalone = { closed: false, context: main } as any;
        await openTable(REF, { window: standalone });
        expect(openTableTab).toHaveBeenCalledWith(main, ITEM, REF, expect.anything());
    });

    it('falls back to the most recent main window only without an origin, or with none to follow', async () => {
        await openTable(REF);
        expect(resolveNavigationWindow).toHaveBeenLastCalledWith(undefined);
        await openTable(REF, { window: { closed: false } as any });
        expect(resolveNavigationWindow).toHaveBeenLastCalledWith(undefined);
        expect(openTableTab).toHaveBeenLastCalledWith(other, ITEM, REF, expect.anything());
    });

    it('waits for the window\'s Beaver renderer before opening the tab', async () => {
        canHostTableTab.mockReturnValueOnce(false).mockReturnValueOnce(false);
        await openTable(REF, { window: main });
        expect(Zotero.Promise.delay).toHaveBeenCalledTimes(2);
        expect(openTableTab).toHaveBeenCalledOnce();
    });

    it('opens the tab before the repair, which can wait behind a write', async () => {
        const order: string[] = [];
        openTableTab.mockImplementation(() => { order.push('tab'); return { tabID: 'tab-1', reused: false }; });
        run.mockImplementation(async () => { order.push('repair'); return { recovered: [] }; });
        await openTable(REF, { window: main });
        expect(order).toEqual(['tab', 'repair']);
        expect(run).toHaveBeenCalledWith('table_openTable', [REF]);
    });

    it('reports a reused tab', async () => {
        openTableTab.mockReturnValue({ tabID: 'tab-1', reused: true });
        await expect(openTable(REF, { window: main })).resolves.toMatchObject({ ok: true, reused: true });
    });

    it('clears the warning in the tab when the repair finds nothing', async () => {
        await openTable(REF, { window: main });
        expect(setTableTabWarning).toHaveBeenCalledWith('tab-1', null);
    });

    it('shows and returns a warning when the snapshot could not be brought up to date', async () => {
        snapshotIsCurrent.mockResolvedValue(false);
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toMatchObject({ ok: true, warning: expect.stringContaining('earlier version') });
        expect(snapshotIsCurrent).toHaveBeenCalledWith(ITEM, 'a'.repeat(64));
        expect(setTableTabWarning).toHaveBeenCalledWith('tab-1', expect.stringContaining('earlier version'));
    });

    it('surfaces unfinished bookkeeping without hiding the table', async () => {
        run.mockResolvedValue({ recovered: [{ kind: 'bookkeeping_pending' }] });
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toMatchObject({ ok: true, warning: expect.stringContaining('Check / repair table') });
        expect(openTableTab).toHaveBeenCalledOnce();
    });

    it.each([
        ['unfinished bookkeeping', () => run.mockResolvedValue({ recovered: [{ kind: 'bookkeeping_pending' }] })],
        ['a stale snapshot', () => snapshotIsCurrent.mockResolvedValue(false)],
    ])('does not promise a repair for %s where Beaver may not modify the table', async (_case, arrange) => {
        arrange();
        tableRepairAllowed.mockReturnValue(false);
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toMatchObject({ ok: true, warning: expect.stringContaining('does not modify tables') });
        expect(tableRepairAllowed).toHaveBeenCalledWith(REF.libraryID);
    });

    it('still opens a table whose library refuses the repair', async () => {
        run.mockRejectedValue(new Error('Library excluded'));
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toMatchObject({ ok: true, warning: expect.stringContaining('could not be checked') });
        expect(openTableTab).toHaveBeenCalledOnce();
    });

    it('opens nothing for a table whose files are not on this device', async () => {
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' });
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toEqual({ error: `Could not open table ${REF.key} — it has no file on disk.` });
        expect(openTableTab).not.toHaveBeenCalled();
        expect(resolveNavigationWindow).not.toHaveBeenCalled();
    });

    it('opens nothing for a table that cannot be read, and says why', async () => {
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'corrupt', message: 'The table is corrupted.' });
        await expect(openTable(REF, { window: main })).resolves.toEqual({
            error: `Could not open table ${REF.key} — The table is corrupted. Select the table in your library and use “Restore my version” in its Beaver Table section to write back the last version this device saved.`,
        });
        expect(openTableTab).not.toHaveBeenCalled();
    });

    it('does not point to a restore that would not run', async () => {
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'corrupt', message: 'The table is corrupted.' });
        for (const outcome of ['no_shadow', 'no_payload', 'not_writable']) {
            restoreCheck.mockResolvedValueOnce(outcome);
            await expect(openTable(REF, { window: main })).resolves.toEqual({
                error: `Could not open table ${REF.key} — The table is corrupted.`,
            });
        }
    });

    it('never retargets a click from a window that closed while the table was read', async () => {
        for (const origin of [{ closed: true }, { closed: false, __beaverRuntime: { status: 'closing' } }]) {
            await expect(openTable(REF, { window: origin as any })).resolves.toEqual({
                error: expect.stringContaining('no Zotero window is available'),
            });
        }
        expect(resolveNavigationWindow).not.toHaveBeenCalled();
        expect(openTableTab).not.toHaveBeenCalled();
    });

    it('says so when no window can show the table', async () => {
        resolveNavigationWindow.mockRejectedValue(new WindowUnavailableError());
        await expect(openTable(REF, { window: main })).resolves.toEqual({
            error: expect.stringContaining('no Zotero window is available'),
        });
    });

    it('passes background and position through, for a reader replaced behind the selected tab', async () => {
        await openTable(REF, { window: main, background: true, index: 2 });
        expect(openTableTab).toHaveBeenCalledWith(main, ITEM, REF, expect.objectContaining({ background: true, index: 2 }));
    });

    it('never throws: a lookup that rejects becomes a returned error', async () => {
        resolveTableItem.mockRejectedValue(new Error('Item NOSUCH is not a table.'));
        // The thrown message carries its own period, so the wrapper adds none.
        await expect(openTable(REF)).resolves.toEqual({
            error: `Could not open table ${REF.key} — Item NOSUCH is not a table.`,
        });
    });

    it('never throws: a tab that cannot be opened becomes a returned error', async () => {
        openTableTab.mockImplementation(() => { throw new Error('This window cannot show a Beaver tab.'); });
        await expect(openTable(REF, { window: main })).resolves.toEqual({
            error: expect.stringContaining('cannot show a Beaver tab'),
        });
    });
});
