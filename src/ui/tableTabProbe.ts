/**
 * `/beaver/test/table-tab` (development and staging only): fixed commands for
 * checking the Beaver tab on a running instance without driving the UI by
 * hand. No command evaluates code; each one drives a product path (the open
 * function, a double-click, a `zotero://open` link, the item-pane button) or
 * reports state (tabs, the saved session, render timings).
 *
 * Timings are taken in the plugin realm with layout forced, not with
 * `requestAnimationFrame`, which Gecko throttles in a window that is not
 * frontmost. The scroll benchmark drives each frame synchronously: scroll,
 * the scroll event (the grid's windowing commits synchronously), forced
 * layout, then `drawWindow` of the viewport.
 */

import { openTable } from './openTable';
import { listTableTabs, tableTabStats, TABLE_TAB_KIND, TABLE_TAB_TYPE } from './tableTab';
import { beaverTabStartup } from './beaverTabs';
import { readTable, type TableRef } from '../services/artifacts/tableItemIdentity';
import type { TableTabRenderReport } from './tableTabTypes';

interface ProbeRequest {
    command?: string;
    key?: string;
    libraryID?: number;
    windowId?: string;
    tabID?: string;
    target?: string;
    path?: string;
    frames?: number;
    step?: number;
    count?: number;
    timeoutMs?: number;
    withHook?: boolean;
    readerItemID?: number;
}

const errors: Array<{ t: number; message: string }> = [];
let consoleListener: { observe(message: any): void } | null = null;
let probeWindow: Window | null = null;

function startErrorCapture(): void {
    if (consoleListener) return;
    const listener = {
        QueryInterface: ChromeUtils.generateQI(['nsIConsoleListener']),
        observe(message: any) {
            try {
                if (!(message instanceof Ci.nsIScriptError)) return;
                if (message.flags & ((Ci.nsIScriptError.warningFlag ?? 1) | (Ci.nsIScriptError.infoFlag ?? 8))) return;
                errors.push({
                    t: Date.now(),
                    message: `${String(message.errorMessage).slice(0, 300)} @ ${message.sourceName ?? ''}:${message.lineNumber ?? ''}`,
                });
                if (errors.length > 200) errors.shift();
            } catch {
                // A message that cannot be read is not worth failing over.
            }
        },
    };
    consoleListener = listener;
    Services.console.registerListener(listener as any);
}

/** Stops the console capture; plugin teardown. */
export function stopTableTabProbe(): void {
    if (!consoleListener) return;
    try {
        Services.console.unregisterListener(consoleListener as any);
    } catch {
        // Already gone.
    }
    consoleListener = null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs: number, interval = 10): Promise<T | null> {
    const start = Date.now();
    for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() - start >= timeoutMs) return null;
        await sleep(interval);
    }
}

function targetWindow(request: ProbeRequest): any {
    const runtime = Zotero.Beaver.runtime.resolveWindow(request.windowId);
    // A named window that is gone is an unavailable target, never another window.
    if (request.windowId != null && runtime?.kind !== 'main') {
        throw Object.assign(new Error('Target window is unavailable'), { code: 'window_unavailable' });
    }
    const win = runtime?.kind === 'main' ? runtime.hostWindow : Zotero.getMainWindow();
    if (!win || win.closed) throw new Error('No main window');
    return win;
}

function refOf(request: ProbeRequest): TableRef {
    if (!request.key) throw new Error('key is required');
    return { libraryID: request.libraryID ?? Zotero.Libraries.userLibraryID, key: request.key };
}

function itemOf(ref: TableRef): Zotero.Item {
    const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key) as Zotero.Item | false;
    if (!item) throw new Error(`No item ${ref.key}`);
    return item;
}

function rowsInDom(win: any, tabID: string): number {
    return win.document.getElementById(tabID)?.querySelectorAll('.bt-table > tbody > tr[data-row-id]').length ?? 0;
}

function tabsSummary(win: any) {
    const tabs = win.Zotero_Tabs;
    const state: Array<{ type: string; title?: string; data?: any; selected?: boolean }> = tabs.getState();
    const beaverIDs = listTableTabs().map((entry) => entry.tabID);
    return {
        selectedID: tabs.selectedID,
        selectedType: tabs.selectedType,
        types: state.map((tab) => tab.type),
        beaver: beaverIDs.map((id) => {
            const container = win.document.getElementById(id);
            return {
                id,
                containerExists: !!container,
                rowsInDom: rowsInDom(win, id),
                scrollHeight: container?.querySelector('.bt-scroll')?.scrollHeight ?? null,
            };
        }),
        beaverInState: state.filter((tab) => tab.type === TABLE_TAB_TYPE).map((tab) => ({ title: tab.title, data: tab.data })),
        // Panes left in the document; one per open Beaver tab, never more.
        paneNodes: win.document.querySelectorAll('.beaver-table-tab').length,
        windowTitle: win.document.title,
    };
}

function entryFor(tabID: string) {
    return listTableTabs().find((entry) => entry.tabID === tabID) ?? null;
}

async function nextRender(tabID: string, after: number, reason: TableTabRenderReport['reason'], timeoutMs: number) {
    return waitFor(() => {
        const renders = entryFor(tabID)?.renders ?? [];
        return renders.length > after && renders[renders.length - 1].reason === reason ? renders[renders.length - 1] : null;
    }, timeoutMs, 5);
}

function selectedBeaverTabFor(win: any, ref: TableRef): string | null {
    const entry = listTableTabs().find((e) => e.key === ref.key && e.libraryID === ref.libraryID);
    return entry && win.Zotero_Tabs.selectedID === entry.tabID ? entry.tabID : null;
}

/** The nearest scrolling ancestor of the table. */
function scroller(root: any): any {
    return root?.querySelector('.bt-scroll') ?? null;
}

function stats(values: number[]) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const pct = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
    return {
        avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
        p50: pct(0.5),
        p95: pct(0.95),
        max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    };
}

function scrollBench(win: any, tabID: string, frames: number, step: number) {
    const root = win.document.getElementById(tabID);
    const el = scroller(root);
    if (!el) return { error: 'no scroll container' };
    el.scrollTop = 0;
    el.dispatchEvent(new win.Event('scroll'));
    void el.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = Math.ceil(rect.width);
    canvas.height = Math.ceil(rect.height);
    const ctx = canvas.getContext('2d');
    const layout: number[] = [];
    const paint: number[] = [];
    let maxRows = 0;
    for (let i = 0; i < frames; i++) {
        const t0 = win.performance.now();
        el.scrollTop += step;
        el.dispatchEvent(new win.Event('scroll'));
        void el.scrollHeight;
        void el.querySelector('tbody > tr:last-child')?.getBoundingClientRect();
        const t1 = win.performance.now();
        ctx.drawWindow(win, rect.left + win.scrollX, rect.top + win.scrollY, rect.width, rect.height, '#fff');
        const t2 = win.performance.now();
        layout.push(t1 - t0);
        paint.push(t2 - t1);
        maxRows = Math.max(maxRows, rowsInDom(win, tabID));
    }
    const total = layout.map((l, i) => l + paint[i]);
    return {
        frames,
        step,
        viewport: { w: canvas.width, h: canvas.height },
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        maxRowsInDom: maxRows,
        layoutMs: stats(layout),
        paintMs: stats(paint),
        frameMs: stats(total),
        over16: total.filter((d) => d > 16.7).length,
        over50: total.filter((d) => d > 50).length,
    };
}

async function screenshot(win: any, path: string): Promise<number> {
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = win.innerWidth;
    canvas.height = win.innerHeight;
    canvas.getContext('2d').drawWindow(win, 0, 0, win.innerWidth, win.innerHeight, '#fff');
    const bin = atob(canvas.toDataURL('image/png').split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await IOUtils.write(path, bytes);
    return bytes.length;
}

/** Waits until `ref` is the selected Beaver tab in `win`, timing it from `t0`. */
async function landed(win: any, ref: TableRef, t0: number, timeoutMs: number) {
    const tabID = await waitFor(() => selectedBeaverTabFor(win, ref), timeoutMs, 5);
    const selectedMs = tabID ? Date.now() - t0 : null;
    const rows = tabID ? await waitFor(() => rowsInDom(win, tabID) > 0, timeoutMs, 5) : null;
    return { tabID, selectedMs, rowsInDomMs: rows ? Date.now() - t0 : null };
}

export async function handleTableTabProbe(request: ProbeRequest = {}): Promise<any> {
    startErrorCapture();
    const win = targetWindow(request);
    const tabs = win.Zotero_Tabs;
    const timeoutMs = request.timeoutMs ?? 30000;
    switch (request.command) {
        case 'state':
            return {
                tabs: tabsSummary(win),
                entries: listTableTabs().map(({ renders, ...rest }) => ({ ...rest, renders: renders.slice(-3) })),
                stats: tableTabStats(),
                startup: beaverTabStartup(),
                mainWindows: Zotero.getMainWindows().length,
                errors: errors.length,
            };
        case 'errors':
            return { errors: errors.slice() };
        case 'clear-errors':
            errors.length = 0;
            return { ok: true };
        case 'open': {
            // The product open from this window, as the item pane calls it.
            const ref = refOf(request);
            const before = tableTabStats();
            const t0 = Date.now();
            const pending = openTable(ref, { window: win });
            const land = landed(win, ref, t0, timeoutMs);
            const outcome = await pending;
            const openReturnedMs = Date.now() - t0;
            const { tabID, selectedMs, rowsInDomMs } = await land;
            const render = tabID && !('reused' in outcome && outcome.reused)
                ? await nextRender(tabID, 0, 'open', timeoutMs)
                : null;
            return {
                outcome,
                selectedMs,
                rowsInDomMs,
                openReturnedMs,
                render,
                opened: tableTabStats().opened - before.opened,
                tabs: tabsSummary(win),
            };
        }
        case 'close': {
            const id = request.tabID ?? tabs.selectedID;
            const before = tableTabStats();
            const t0 = win.performance.now();
            tabs.close(id);
            const closeMs = Math.round(win.performance.now() - t0);
            const sync = { closeMs, closed: tableTabStats().closed - before.closed, unmounted: tableTabStats().unmounted - before.unmounted };
            await sleep(200);
            return { ...sync, containerAfterTick: !!win.document.getElementById(id), stats: tableTabStats(), tabs: tabsSummary(win) };
        }
        case 'select': {
            const id = request.target === 'library' ? 'zotero-pane' : request.target;
            if (!id) return { error: 'target is required' };
            tabs.select(id);
            await sleep(300);
            return { tabs: tabsSummary(win) };
        }
        case 'doubleclick': {
            // What a double-click on the item in the items tree does.
            const ref = refOf(request);
            const t0 = Date.now();
            await win.ZoteroPane.viewItems([itemOf(ref)]);
            const result = await landed(win, ref, t0, timeoutMs);
            await sleep(300);
            return { ...result, stats: tableTabStats(), tabs: tabsSummary(win) };
        }
        case 'open-uri': {
            // A `zotero://open` link, through the pane's own link handling.
            const ref = refOf(request);
            const library = ref.libraryID === Zotero.Libraries.userLibraryID
                ? 'library'
                : `groups/${Zotero.Groups.getGroupIDFromLibraryID(ref.libraryID)}`;
            const t0 = Date.now();
            win.ZoteroPane.loadURI(`zotero://open/${library}/items/${ref.key}`);
            const result = await landed(win, ref, t0, timeoutMs);
            await sleep(300);
            return { ...result, stats: tableTabStats(), tabs: tabsSummary(win) };
        }
        case 'reader-window': {
            // A reader window on the table, as Zotero opens one with
            // "Open in new window" set: it lands in the Beaver tab instead.
            const ref = refOf(request);
            const item = itemOf(ref);
            const t0 = Date.now();
            await (Zotero.Reader as any).open(item.id, null, { openInWindow: true });
            const result = await landed(win, ref, t0, timeoutMs);
            await sleep(300);
            const readers = ((Zotero.Reader as any)._readers ?? []).filter((r: any) => r?.itemID === item.id);
            return {
                ...result,
                readersLeft: readers.length,
                readerWindowsOpen: readers.filter((r: any) => !r.tabID && r._window && !r._window.closed).length,
                stats: tableTabStats(),
                tabs: tabsSummary(win),
            };
        }
        case 'item-pane': {
            // The item pane's "Open table" button, clicked.
            const ref = refOf(request);
            const item = itemOf(ref);
            tabs.select('zotero-pane');
            await win.ZoteroPane.selectItem(item.id);
            const button = await waitFor(() => {
                const el = win.document.querySelector('[data-beaver-action="open"]');
                return el && !el.disabled ? el : null;
            }, timeoutMs, 25);
            if (!button) return { error: 'The item pane has no enabled Open table button' };
            const t0 = Date.now();
            button.click();
            const result = await landed(win, ref, t0, timeoutMs);
            await sleep(300);
            return { ...result, stats: tableTabStats(), tabs: tabsSummary(win) };
        }
        case 'session': {
            await Zotero.Session.save();
            const text = await IOUtils.readUTF8(PathUtils.join(Zotero.Profile.dir, 'session.json'));
            const pane = JSON.parse(text).windows?.find((w: any) => w.type === 'pane');
            return {
                tabTypes: pane?.tabs?.map((t: any) => t.type) ?? [],
                beaverEntries: pane?.tabs?.filter((t: any) => t.type === TABLE_TAB_TYPE).length ?? 0,
            };
        }
        case 'session-file': {
            // The file as it is, without saving first.
            const text = await IOUtils.readUTF8(PathUtils.join(Zotero.Profile.dir, 'session.json'));
            const pane = JSON.parse(text).windows?.find((w: any) => w.type === 'pane');
            return {
                tabTypes: pane?.tabs?.map((t: any) => t.type) ?? [],
                beaverEntries: pane?.tabs?.filter((t: any) => t.type === TABLE_TAB_TYPE).length ?? 0,
            };
        }
        case 'restore-probe': {
            // Replays Zotero_Tabs.restoreState with a saved Beaver tab followed
            // by a reader tab, with or without the hook.
            const hooks = tabs.tabHooks.restoreState;
            const saved = hooks.beaver;
            if (request.withHook === false) delete hooks.beaver;
            const before = tabs.getState().length;
            const idsBefore = new Set(Array.from(win.document.getElementById('tabs-deck')?.children ?? []).map((el: any) => el.id));
            let error: string | null = null;
            try {
                await tabs.restoreState([
                    { type: TABLE_TAB_TYPE, title: 'Probe table', data: { itemID: 1, beaverTab: { kind: TABLE_TAB_KIND, ref: { libraryID: 1, key: 'PROBEKEY' } } } },
                    { type: 'reader', title: 'Probe reader after table', data: { itemID: request.readerItemID } },
                ]);
            } catch (e) {
                error = String((e as Error)?.message ?? e);
            } finally {
                if (saved) hooks.beaver = saved;
            }
            const added = Array.from(win.document.getElementById('tabs-deck')?.children ?? [])
                .map((el: any) => el.id)
                .filter((id: string) => !idsBefore.has(id));
            const after = tabs.getState().length;
            if (added.length) tabs.close(added);
            return { withHook: request.withHook !== false, error, restoredTabs: after - before };
        }
        case 'toggle-title-pref': {
            // Zotero renames every tab with `data.itemID` when this changes.
            const current = Zotero.Prefs.get('tabs.title.reader') as string;
            const other = current === 'filename' ? 'titleCreatorYear' : 'filename';
            Zotero.Prefs.set('tabs.title.reader', other);
            await sleep(800);
            const during = tabs.getState().filter((t: any) => t.type === TABLE_TAB_TYPE).map((t: any) => t.title);
            Zotero.Prefs.set('tabs.title.reader', current);
            await sleep(800);
            return { during, tabs: tabsSummary(win) };
        }
        case 'scroll-bench': {
            const tabID = request.tabID ?? tabs.selectedID;
            if (!entryFor(tabID)) return { error: 'not a Beaver tab' };
            return scrollBench(win, tabID, request.frames ?? 120, request.step ?? 120);
        }
        case 'commit-bench': {
            // `count` writes through the store's own write path, each touching
            // one cell (the last also the title), timed from the write to the
            // tab's re-render of that version.
            const ref = refOf(request);
            const tabID = listTableTabs().find((e) => e.key === ref.key && e.libraryID === ref.libraryID)?.tabID;
            if (!tabID) return { error: 'open the table first' };
            const { spec } = await readTable(ref);
            const column = spec.columns.find((c) => c.type === 'text' && !c.system && c.id !== spec.anchor_column_id);
            if (!column) return { error: 'no text column' };
            const count = request.count ?? 10;
            const runs: any[] = [];
            for (let i = 0; i < count; i++) {
                const row = spec.rows[(i * 97) % spec.rows.length];
                const rendersBefore = entryFor(tabID)?.renders.length ?? 0;
                const mutations: any[] = [{
                    op: 'set_cells',
                    cells: [{
                        row: row.id,
                        column: column.id,
                        cell: { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: `Benchmark edit ${i + 1} at ${new Date().toISOString()}` } },
                    }],
                }];
                if (i === count - 1 && request.target) mutations.push({ op: 'set_meta', title: request.target });
                const t0 = Date.now();
                const result: any = await Zotero.Beaver.libraryOperations.run('table_editTable', [
                    ref,
                    mutations,
                    { actor: 'user', change: 'Tab benchmark edit' },
                ] as any);
                const commitMs = Date.now() - t0;
                const render = await nextRender(tabID, rendersBefore, 'update', timeoutMs);
                runs.push({
                    version: result?.version ?? null,
                    saved: result?.saved ?? null,
                    commitMs,
                    renderedVersion: render?.version ?? null,
                    endToEndMs: render ? Date.now() - t0 : null,
                    tabReadMs: render?.readMs ?? null,
                    tabCommitMs: render?.commitMs ?? null,
                    rowsInDom: render?.rowsInDom ?? null,
                });
            }
            return {
                runs,
                commitMs: stats(runs.map((r) => r.commitMs)),
                tabRenderMs: stats(runs.filter((r) => r.tabCommitMs != null).map((r) => r.tabCommitMs)),
                endToEndMs: stats(runs.filter((r) => r.endToEndMs != null).map((r) => r.endToEndMs)),
                tabs: tabsSummary(win),
            };
        }
        case 'screenshot': {
            const path = request.path ?? PathUtils.join(PathUtils.tempDir, 'beaver-table-tab.png');
            return { path, bytes: await screenshot(win, path) };
        }
        case 'open-main-window': {
            // A second main window, which restores its tabs from the session.
            const nw = Services.ww.openWindow(null as any, 'chrome://zotero/content/zoteroPane.xhtml', '_blank', 'chrome,all,dialog=no,resizable', null as any) as any;
            probeWindow = nw;
            await waitFor(() => nw.Zotero_Tabs && nw.document.readyState === 'complete', timeoutMs, 50);
            await waitFor(() => nw.__beaverRuntime?.status === 'ready', timeoutMs, 50);
            return {
                mainWindows: Zotero.getMainWindows().length,
                windowId: nw.__beaverRuntime?.id ?? null,
                tabTypes: nw.Zotero_Tabs.getState().map((t: any) => t.type),
                hooksInstalled: !!nw.Zotero_Tabs.tabHooks.restoreState?.beaver,
            };
        }
        case 'close-probe-window': {
            const target = probeWindow;
            probeWindow = null;
            if (!target || target.closed) return { closed: 0 };
            target.close();
            await sleep(1000);
            return { closed: 1, mainWindows: Zotero.getMainWindows().length, stats: tableTabStats() };
        }
        default:
            return { error: `unknown command ${request.command}` };
    }
}
