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
const tableRepairAllowed = vi.hoisted(() => vi.fn(() => true));
const findTableWindow = vi.hoisted(() => vi.fn(() => null as unknown));
const openTableWindow = vi.hoisted(() => vi.fn());
const setTableWindowWarning = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/artifacts/tableItemIdentity', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../src/services/artifacts/tableItemIdentity')>();
    return {
        TABLE_REPAIR_SKIPPED: original.TABLE_REPAIR_SKIPPED,
        tableReadProblem: original.tableReadProblem,
        tableRepairAllowed,
        resolveTableItem,
        readTableItemSpec,
        tableFilesDownloadable: original.tableFilesDownloadable,
    };
});
vi.mock('../../../src/services/artifacts/tableRenderer', () => ({ snapshotIsCurrent }));
vi.mock('../../../src/ui/tableTab', () => ({ canHostTableTab, openTableTab, setTableTabWarning }));
vi.mock('../../../src/ui/tableWindow', () => ({ findTableWindow, openTableWindow, setTableWindowWarning }));
vi.mock('../../../src/runtime/navigation', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/runtime/navigation')>()),
    contextMainWindow,
    resolveNavigationWindow,
}));

import { openTable } from '../../../src/ui/openTable';
import { WindowUnavailableError } from '../../../src/runtime/navigation';

const REF = { libraryID: 1, key: 'TABLEKEY' };
const SPEC = { id: 't', key: REF.key, version: 4, title: 'Spec', columns: [], rows: [] };
const ITEM = { id: 42, key: REF.key, libraryID: REF.libraryID, getField: () => 'Comparison' };

const main = { closed: false, __beaverRuntime: { status: 'ready' } } as any;
const other = { closed: false, __beaverRuntime: { status: 'ready' } } as any;
const tableWin = { closed: false, __beaverRuntime: { status: 'ready', kind: 'table' } } as any;
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
    findTableWindow.mockReturnValue(null);
    openTableWindow.mockReturnValue({ win: tableWin, reused: false });
    run = vi.fn().mockResolvedValue({ recovered: [], sha256: 'a'.repeat(64) });
    (Zotero as any).Beaver = { ...(Zotero as any).Beaver, libraryOperations: { run } };
    (Zotero as any).Promise = { delay: vi.fn(async () => {}) };
    (Zotero as any).Sync = {
        Storage: { Local: { getEnabledForLibrary: vi.fn(() => false) } },
        Runner: { downloadFile: vi.fn(async () => ({ localChanges: true })) },
    };
});

describe('openTable', () => {
    it("opens the Beaver tab in the origin's main window with the spec it read", async () => {
        await expect(openTable(REF, { window: main })).resolves.toEqual({ ok: true, surface: 'tab', tabID: 'tab-1', reused: false });
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

    it('brings a cited row and cell into view when the table has them', async () => {
        const spec = { ...SPEC, columns: [{ id: 'design', header: 'Design', type: 'select' }], rows: [{ id: 'r1', cells: {} }] };
        readTableItemSpec.mockResolvedValue({ ok: true, spec, file: { spec } });
        await expect(openTable(REF, { window: main, focus: { rowId: 'r1', columnId: 'design' } }))
            .resolves.toMatchObject({ ok: true, focus: 'found' });
        expect(openTableTab).toHaveBeenLastCalledWith(main, ITEM, REF, expect.objectContaining({
            focus: { rowId: 'r1', columnId: 'design' },
        }));
        await expect(openTable(REF, { window: main, focus: { rowId: 'r1' } })).resolves.toMatchObject({ focus: 'found' });
    });

    it("passes a fill's failed rows to the tab", async () => {
        const request = { kind: 'show_failed' as const, job_id: 'job-1', row_ids: ['r1'] };
        await expect(openTable(REF, { window: main, request })).resolves.toMatchObject({ ok: true });
        expect(openTableTab).toHaveBeenLastCalledWith(main, ITEM, REF, expect.objectContaining({ request }));
    });

    it('opens the table without a focus when the cited row or column is gone', async () => {
        const spec = { ...SPEC, columns: [{ id: 'design', header: 'Design', type: 'select' }], rows: [{ id: 'r1', cells: {} }] };
        readTableItemSpec.mockResolvedValue({ ok: true, spec, file: { spec } });
        for (const focus of [{ rowId: 'r9', columnId: 'design' }, { rowId: 'r1', columnId: 'country' }]) {
            await expect(openTable(REF, { window: main, focus })).resolves.toMatchObject({ ok: true, focus: 'missing' });
            expect(openTableTab.mock.lastCall?.[3]).not.toHaveProperty('focus');
        }
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
        expect(outcome).toMatchObject({ ok: true, warning: expect.stringContaining('could not update its version history') });
        expect(openTableTab).toHaveBeenCalledOnce();
    });

    it.each([
        ['unfinished bookkeeping', () => run.mockResolvedValue({ recovered: [{ kind: 'bookkeeping_pending' }] })],
        ['a stale snapshot', () => snapshotIsCurrent.mockResolvedValue(false)],
    ])('does not promise a repair for %s where Beaver may not modify the table', async (_case, arrange) => {
        arrange();
        tableRepairAllowed.mockReturnValue(false);
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toMatchObject({ ok: true, warning: expect.stringContaining('does not change tables') });
        expect(tableRepairAllowed).toHaveBeenCalledWith(REF.libraryID);
    });

    it('still opens a table whose library refuses the repair', async () => {
        run.mockRejectedValue(new Error('Library excluded'));
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toMatchObject({ ok: true, warning: expect.stringContaining('could not finish checking this table') });
        expect(openTableTab).toHaveBeenCalledOnce();
    });

    it('opens nothing for a table whose files are not on this device', async () => {
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' });
        const outcome = await openTable(REF, { window: main });
        expect(outcome).toEqual({ error: "Couldn't open “Comparison”. Its file isn't on this device." });
        expect(openTableTab).not.toHaveBeenCalled();
        expect(resolveNavigationWindow).not.toHaveBeenCalled();
    });

    it('downloads a table synced on demand before opening it', async () => {
        (Zotero as any).Sync.Storage.Local.getEnabledForLibrary.mockReturnValue(true);
        readTableItemSpec
            .mockResolvedValueOnce({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' })
            .mockResolvedValueOnce({ ok: true, spec: SPEC, file: { spec: SPEC } });
        await expect(openTable(REF, { window: main })).resolves.toMatchObject({ ok: true, tabID: 'tab-1' });
        expect((Zotero as any).Sync.Runner.downloadFile).toHaveBeenCalledWith(ITEM);
        expect(openTableTab).toHaveBeenCalledOnce();
    });

    it.each([
        ['throws', () => Promise.reject(new Error('offline'))],
        ['does not run', () => Promise.resolve(false)],
    ])('says the download failed when it %s', async (_label, download) => {
        (Zotero as any).Sync.Storage.Local.getEnabledForLibrary.mockReturnValue(true);
        (Zotero as any).Sync.Runner.downloadFile.mockImplementationOnce(download);
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' });
        await expect(openTable(REF, { window: main })).resolves.toEqual({
            error: "Couldn't open “Comparison”. Its file couldn't be downloaded to this device.",
        });
        expect(readTableItemSpec).toHaveBeenCalledOnce();
        expect(openTableTab).not.toHaveBeenCalled();
    });

    it('reports a download only when one starts', async () => {
        const onDownload = vi.fn();
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' });
        await expect(openTable(REF, { window: main, onDownload })).resolves.toEqual({
            error: "Couldn't open “Comparison”. Its file isn't on this device.",
        });
        expect(onDownload).not.toHaveBeenCalled();
        expect((Zotero as any).Sync.Runner.downloadFile).not.toHaveBeenCalled();

        (Zotero as any).Sync.Storage.Local.getEnabledForLibrary.mockReturnValue(true);
        readTableItemSpec
            .mockResolvedValueOnce({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' })
            .mockResolvedValueOnce({ ok: true, spec: SPEC, file: { spec: SPEC } });
        await openTable(REF, { window: main, onDownload });
        expect(onDownload).toHaveBeenCalledOnce();
    });

    it('shares one download between opens of the same table', async () => {
        (Zotero as any).Sync.Storage.Local.getEnabledForLibrary.mockReturnValue(true);
        let finish!: (result: unknown) => void;
        (Zotero as any).Sync.Runner.downloadFile.mockImplementationOnce(
            () => new Promise((resolve) => { finish = resolve; })
        );
        readTableItemSpec
            .mockResolvedValueOnce({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' })
            .mockResolvedValueOnce({ ok: false, code: 'no_file', message: 'Table TABLEKEY has no file on disk.' })
            .mockResolvedValue({ ok: true, spec: SPEC, file: { spec: SPEC } });
        const first = openTable(REF, { window: main });
        const second = openTable(REF, { window: main });
        await vi.waitFor(() => expect(readTableItemSpec).toHaveBeenCalledTimes(2));
        finish({ localChanges: true });
        await expect(Promise.all([first, second])).resolves.toMatchObject([{ ok: true }, { ok: true }]);
        expect((Zotero as any).Sync.Runner.downloadFile).toHaveBeenCalledOnce();
    });

    it('opens nothing for a table that cannot be read, and says why in plain words', async () => {
        readTableItemSpec.mockResolvedValue({
            ok: false,
            code: 'invalid',
            message: `Table ${REF.key} is not readable JSON: SyntaxError: JSON.parse: unexpected character`,
        });
        await expect(openTable(REF, { window: main })).resolves.toEqual({
            error: "Couldn't open “Comparison”. Its saved file is damaged, so Beaver can't read it.",
        });
        expect(openTableTab).not.toHaveBeenCalled();
    });

    it('says the file is missing when only the version history remains', async () => {
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'corrupt', message: 'Table TABLEKEY has no table.json; recover this device\'s version or revert to a retained version to repair it.' });
        await expect(openTable(REF, { window: main })).resolves.toEqual({
            error: "Couldn't open “Comparison”. Its saved file is missing, so Beaver can't read it.",
        });
    });

    it('says a table from a newer format needs a Beaver update', async () => {
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'unsupported_version', message: 'Table TABLEKEY was written in another format (spec_version 99).' });
        await expect(openTable(REF, { window: main })).resolves.toEqual({
            error: "Couldn't open “Comparison”. It was saved in a format this version of Beaver can't read. Updating Beaver may fix this.",
        });
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

    it('opens the table in its own window when asked, with the spec it read', async () => {
        await expect(openTable(REF, { openIn: 'window' })).resolves.toEqual({ ok: true, surface: 'window', reused: false });
        expect(openTableWindow).toHaveBeenCalledWith(ITEM, REF, { initial: { spec: SPEC, version: 4 } });
        expect(openTableTab).not.toHaveBeenCalled();
        // A window needs no main window to host it.
        expect(resolveNavigationWindow).not.toHaveBeenCalled();
    });

    it('opens the window before the repair and shows what the repair reports there', async () => {
        const order: string[] = [];
        openTableWindow.mockImplementation(() => { order.push('window'); return { win: tableWin, reused: false }; });
        run.mockImplementation(async () => { order.push('repair'); return { recovered: [{ kind: 'bookkeeping_pending' }] }; });
        const outcome = await openTable(REF, { openIn: 'window' });
        expect(order).toEqual(['window', 'repair']);
        expect(outcome).toMatchObject({ ok: true, surface: 'window', warning: expect.stringContaining('version history') });
        expect(setTableWindowWarning).toHaveBeenCalledWith(tableWin, expect.stringContaining('version history'));
    });

    it('brings forward the window already showing the table, with a cited cell', async () => {
        findTableWindow.mockReturnValue(tableWin);
        openTableWindow.mockReturnValue({ win: tableWin, reused: true });
        const spec = { ...SPEC, columns: [{ id: 'design', header: 'Design', type: 'select' }], rows: [{ id: 'r1', cells: {} }] };
        readTableItemSpec.mockResolvedValue({ ok: true, spec, file: { spec } });
        await expect(openTable(REF, { window: main, focus: { rowId: 'r1', columnId: 'design' } }))
            .resolves.toEqual({ ok: true, surface: 'window', reused: true, focus: 'found' });
        expect(openTableWindow).toHaveBeenCalledWith(ITEM, REF, expect.objectContaining({ focus: { rowId: 'r1', columnId: 'design' } }));
        expect(openTableTab).not.toHaveBeenCalled();
    });

    it('opens a tab when asked for one, even with the table in a window', async () => {
        findTableWindow.mockReturnValue(tableWin);
        await expect(openTable(REF, { window: main, openIn: 'tab' })).resolves.toMatchObject({ ok: true, surface: 'tab' });
        expect(openTableWindow).not.toHaveBeenCalled();
        expect(openTableTab).toHaveBeenCalledOnce();
    });

    it('opens no window for a table that cannot be read', async () => {
        readTableItemSpec.mockResolvedValue({ ok: false, code: 'invalid', message: 'bad' });
        await expect(openTable(REF, { openIn: 'window' })).resolves.toHaveProperty('error');
        expect(openTableWindow).not.toHaveBeenCalled();
    });

    it('never throws: a window that cannot be opened becomes a returned error', async () => {
        openTableWindow.mockImplementation(() => { throw new Error('Beaver is not running.'); });
        await expect(openTable(REF, { openIn: 'window' })).resolves.toEqual({
            error: expect.stringContaining('Beaver is not running'),
        });
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
