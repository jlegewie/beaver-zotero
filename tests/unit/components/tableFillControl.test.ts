// @vitest-environment jsdom

/**
 * The tab's Fill control: the button's count and its idle state, the popover
 * showing a plan with its cost and starting exactly that plan, the Stop
 * button while a job runs, the result banner, and the way to credits for a
 * balance that falls short.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row, TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableFillJobSnapshot, TableFillPlanSummary } from '@beaver/agent-core/protocol/tableFillProtocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    openPreferencesWindow: vi.fn(),
    prefs: {} as Record<string, unknown>,
    onPrefChange: () => {},
}));

vi.mock('../../../react/runtime/windowRuntime', () => ({ getWindowRuntime: () => ({}), getHostWindow: () => window }));
vi.mock('../../../react/ui/openPreferencesWindow', () => ({ openPreferencesWindow: mocks.openPreferencesWindow }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => mocks.prefs[key],
    setPref: (key: string, value: unknown) => {
        mocks.prefs[key] = value;
        mocks.onPrefChange();
    },
}));
// The account's balance as the renderer projects it; null while the profile is unknown.
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    const balanceAtom = atom<number | null>(null);
    return {
        balanceAtom,
        profileWithPlanAtom: atom((get) => (get(balanceAtom) == null ? null : {})),
        remainingBeaverCreditsAtom: atom((get) => get(balanceAtom) ?? 0),
    };
});

import { getDefaultStore } from 'jotai';
import * as profile from '../../../react/atoms/profile';
import { preferencesRevisionAtom } from '../../../react/atoms/preferences';
import {
    TableFillBanner,
    TableFillButton,
    useNoCreditsNotice,
    type TableFillButtonHandle,
} from '../../../react/components/tables/TableFillControl';

const balanceAtom = (profile as any).balanceAtom;
// Writing a preference bumps the revision, as the native observer does.
mocks.onPrefChange = () => getDefaultStore().set(preferencesRevisionAtom, (n) => n + 1);
const setBalance = (balance: number | null) => act(() => getDefaultStore().set(balanceAtom, balance));

const ref = { libraryID: 1, key: 'TABLE001' };

const row = (id: string, cells: Row['cells'] = {}, extra: Partial<Row> = {}): Row => ({ id, cells, ...extra });
const answered = { outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'x' }, documents: ['u-A'] } as const;

function spec(rows: Row[]): TableSpec {
    return { id: 't', title: 'Trials', columns: [{ id: 'method', header: 'Method', type: 'text' }], rows };
}

const plan: TableFillPlanSummary = {
    plan_id: 'plan-1',
    table: { ...ref, title: 'Trials' },
    scope: { kind: 'pending' },
    rows: 2,
    cells: 2,
    documents: 2,
    document_kinds: { pdf: 2 },
    title_abstract: 0,
    no_input: 0,
    unavailable: 0,
    credits: 0.4,
    prices: { document: 0.2, title_abstract: 0.05 },
    pending: { rows: 2, cells: 2, new_rows: 2, columns: [], retry_rows: 0, blocked_rows: 0 },
    rereads: 0,
    balance: 0.2,
    expires_at: Date.now() + 60_000,
};

const running: TableFillJobSnapshot = {
    job_id: 'job-1',
    plan_id: 'plan-1',
    table: { ...ref, title: 'Trials' },
    origin: { kind: 'user' },
    state: 'running',
    rows_total: 46,
    rows_done: 12,
    rows_failed: 0,
    in_flight: 3,
    credits_charged: 2.4,
    credits_planned: 9.2,
    balance: 10,
    started_at: 0,
    seconds_left: 200,
};

const accountRefresh = vi.fn(async () => {});
let container: HTMLDivElement;
let root: Root;
const fills = {
    plan: vi.fn(async () => ({ ok: true, plan })),
    start: vi.fn(async () => ({ ok: true, job: running })),
    trial: vi.fn((): any => ({ ok: true, plan: { ...plan, plan_id: 'trial-1', scope: { kind: 'pending', limit: 5 }, rows: 5, documents: 5 } })),
    stop: vi.fn(() => true),
    dismiss: vi.fn(),
    jobForTable: vi.fn(() => null),
};

beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.prefs)) delete mocks.prefs[key];
    getDefaultStore().set(balanceAtom, null);
    (globalThis as any).Zotero = {
        Beaver: { tableFills: fills, runtime: { subscribeWindow: () => () => {} }, account: { refresh: accountRefresh } },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const render = (element: React.ReactElement) => act(() => root.render(element));
/** A button's own text: icons (a spinner carries a stylesheet) left out. */
const label = (button: Element) =>
    [...button.childNodes]
        .filter((node) => (node as Element).tagName?.toLowerCase() !== 'svg' && !(node as Element).querySelector?.('svg'))
        .map((node) => node.textContent)
        .join('')
        .trim();
const buttonNamed = (text: string, within = '') =>
    [...container.querySelectorAll(`${within} button`.trim())].find((b) => label(b) === text) as HTMLButtonElement | undefined;

describe('TableFillButton', () => {
    it('counts the new and stale rows, and reads "Fill" when everything is up to date', () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }));
        expect(buttonNamed('Fill 2 rows')).toBeDefined();
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a', { method: answered }, { documents: ['u-A'] })]), job: null, improvableRows: new Set<string>() }));
        const idle = buttonNamed('Fill')!;
        expect(label(idle)).toBe('Fill');
        expect(idle.getAttribute('title')).toBe('Everything is up to date');
    });

    it('does not light for a row that only needs a retry', () => {
        render(
            React.createElement(TableFillButton, {
                tableRef: ref,
                table: spec([row('a', {}, { failure: { code: 'no_source', message: 'x' } })]),
                job: null,
                improvableRows: new Set<string>(),
            }),
        );
        expect(buttonNamed('Fill')).toBeDefined();
        expect(buttonNamed('Fill 1 row')).toBeUndefined();
    });

    it('shows the plan with its cost, warns of a short balance, and starts exactly that plan', async () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 2 rows')!.click());
        expect(fills.plan).toHaveBeenCalledWith(ref, { kind: 'pending' });
        const popover = container.querySelector('[role="dialog"]')!;
        expect(popover.querySelector('.bt-fill-title')?.textContent).toBe('Fill 2 items');
        const cost = popover.querySelector('.bt-fill-cost')!;
        expect(cost.textContent).toBe('0.4 credits');
        expect(cost.getAttribute('title')).toContain('Filling costs 0.2 credits per item');
        expect(popover.textContent).toContain('2 from PDF');
        // Never filled: no change lines, the heading says what is filled.
        expect(popover.querySelector('.bt-fill-changes')).toBeNull();
        expect(popover.textContent).toContain('Your 0.2 credits cover about 1 of 2 items');
        act(() => buttonNamed('Add credits')!.click());
        expect(mocks.openPreferencesWindow).toHaveBeenCalledWith('billing');
        await act(async () => buttonNamed('Fill 2')!.click());
        expect(fills.start).toHaveBeenCalledWith('plan-1');
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('shows no balance when it covers the fill', async () => {
        fills.plan.mockResolvedValueOnce({ ok: true, plan: { ...plan, balance: 640 } });
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 2 rows')!.click());
        const popover = container.querySelector('[role="dialog"]')!;
        expect(popover.textContent).not.toContain('640');
        expect(popover.querySelector('.bt-fill-reach')).toBeNull();
    });

    it('offers Get credits instead of Fill when the balance cannot pay for one item', async () => {
        fills.plan.mockResolvedValueOnce({ ok: true, plan: { ...plan, rows: 7, documents: 7, credits: 1.4, balance: 0 } });
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 2 rows')!.click());
        const popover = container.querySelector('[role="dialog"]')!;
        expect(popover.querySelector('.bt-fill-cost')?.textContent).toBe('1.4 credits');
        expect(popover.textContent).toContain('Filling uses Beaver credits: 0.2 per item. You have 0 credits.');
        expect(popover.textContent).toContain('You can still add rows and edit cells by hand.');
        expect(popover.textContent).not.toContain('cover about');
        expect(buttonNamed('Fill 7')).toBeUndefined();
        expect(buttonNamed('Try 5 first')).toBeUndefined();
        act(() => buttonNamed('Get credits')!.click());
        expect(mocks.openPreferencesWindow).toHaveBeenCalledWith('billing');
        // The popover stays, so credits bought meanwhile can start the fill.
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        expect(fills.start).not.toHaveBeenCalled();
    });

    it('turns Get credits back into Fill once credits arrive while the popover is open', async () => {
        setBalance(0);
        // The tab's notice is on screen too: both prompts read the balance on focus.
        render(
            React.createElement(React.Fragment, null,
                React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }),
                React.createElement(function Notice() { return useNoCreditsNotice(true); }),
            ),
        );
        await act(async () => buttonNamed('Fill 2 rows')!.click());
        expect(container.querySelector('.bt-fill-banner')).not.toBeNull();
        // Coming back from the browser reads the balance again, once
        // however many credits prompts are on screen.
        window.dispatchEvent(new Event('focus'));
        expect(accountRefresh).toHaveBeenCalledTimes(1);
        expect(accountRefresh).toHaveBeenCalledWith(true);
        // The live balance wins over the plan's (0.2, which would cover one item).
        expect(buttonNamed('Get credits', '.bt-fill-popover')).toBeDefined();
        expect(buttonNamed('Fill 2')).toBeUndefined();
        setBalance(25);
        expect(buttonNamed('Get credits')).toBeUndefined();
        expect(container.querySelector('.bt-fill-reach')).toBeNull();
        // With enough credits, focus no longer asks for the balance.
        accountRefresh.mockClear();
        window.dispatchEvent(new Event('focus'));
        expect(accountRefresh).not.toHaveBeenCalled();
        await act(async () => buttonNamed('Fill 2')!.click());
        expect(fills.start).toHaveBeenCalledWith('plan-1');
    });

    it('names a column without answers as new, and one with answers by its empty cells', async () => {
        const columnPlan = { ...plan, pending: { ...plan.pending, new_rows: 0, columns: [{ id: 'method', header: 'Method', reason: 'new' as const, cells: 1 }] } };
        fills.plan.mockResolvedValue({ ok: true, plan: columnPlan });
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a'), row('b')]), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 2 rows')!.click());
        const change = () => [...container.querySelectorAll('.bt-fill-changes dt, .bt-fill-changes dd')].map((e) => e.textContent);
        expect(change()).toEqual(['New column', 'Method']);
        act(() => buttonNamed('Cancel')!.click());
        const partly = spec([row('a', { method: answered }, { documents: ['u-A'] }), row('b')]);
        render(React.createElement(TableFillButton, { tableRef: ref, table: partly, job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 1 row')!.click());
        expect(change()).toEqual(['Empty cells', 'Method']);
        fills.plan.mockReset();
        fills.plan.mockImplementation(async () => ({ ok: true, plan }));
    });

    it('keeps the popover open with the reason when the start is refused', async () => {
        fills.start.mockResolvedValueOnce({ ok: false, code: 'fill_in_progress', message: 'This table is already being filled.' } as any);
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 1 row')!.click());
        await act(async () => buttonNamed('Fill 2')!.click());
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('This table is already being filled.');
    });

    it('is the Stop button while a job runs, and says it is stopping after Stop', () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: running, improvableRows: new Set<string>() }));
        act(() => buttonNamed('Stop · 12/46')!.click());
        expect(fills.stop).toHaveBeenCalledWith('job-1');
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: { ...running, state: 'stopping' }, improvableRows: new Set<string>() }));
        const stopping = buttonNamed('Stopping… finishing 3 items')!;
        expect(stopping.disabled).toBe(true);
    });

    it('is disabled with the reason in a read-only library', () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec([row('a')]), job: null, improvableRows: new Set<string>(), disabledReason: 'This library is read-only.' }));
        const main = buttonNamed('Fill 1 row')!;
        expect(main.disabled).toBe(true);
        expect(main.getAttribute('title')).toBe('This library is read-only.');
    });
});

describe('the Fill menu and plans asked for elsewhere in the tab', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => row(id));
    const menuItem = (text: string) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith(text));

    it('offers everything pending, the five-row trial, the selected rows and retries, each with its count', async () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec(rows), job: null, improvableRows: new Set<string>() }));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More ways to fill"]')!.click());
        expect(menuItem('Fill everything pending')?.textContent).toContain('7');
        expect(menuItem('Try on 5 rows first')?.textContent).toContain('5');
        expect(menuItem('Fill selected rows')?.textContent).toContain('Select rows first');
        expect(menuItem('Fill selected rows')?.getAttribute('aria-disabled')).toBe('true');
        await act(async () => menuItem('Try on 5 rows first')!.click());
        expect(fills.plan).toHaveBeenCalledWith(ref, { kind: 'pending', limit: 5 });
    });

    it('fills the rows selected in the table', async () => {
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec(rows), job: null, improvableRows: new Set<string>(), selectedRowIds: ['b', 'c'] }));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More ways to fill"]')!.click());
        await act(async () => menuItem('Fill selected rows')!.click());
        expect(fills.plan).toHaveBeenCalledWith(ref, { kind: 'cells', rows: ['b', 'c'] });
    });

    it("starts the first five rows of the plan shown, without a second confirmation", async () => {
        fills.plan.mockResolvedValueOnce({ ok: true, plan: { ...plan, rows: 7, documents: 7 } });
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec(rows), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 7 rows')!.click());
        await act(async () => buttonNamed('Try 5 first')!.click());
        expect(fills.plan).toHaveBeenCalledTimes(1);
        expect(fills.trial).toHaveBeenCalledWith('plan-1', 5);
        expect(fills.start).toHaveBeenCalledWith('trial-1');
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('keeps the whole plan with the reason when the trial cannot be planned', async () => {
        fills.plan.mockResolvedValueOnce({ ok: true, plan: { ...plan, rows: 7, documents: 7 } });
        fills.trial.mockReturnValueOnce({ ok: false, message: 'The table changed.' });
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec(rows), job: null, improvableRows: new Set<string>() }));
        await act(async () => buttonNamed('Fill 7 rows')!.click());
        await act(async () => buttonNamed('Try 5 first')!.click());
        expect(fills.start).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('The table changed.');
        expect(buttonNamed('Fill 7')).toBeDefined();
    });

    it('shows the plan a row or a column asks for, unless a fill is running', async () => {
        const handle = React.createRef<TableFillButtonHandle>();
        render(React.createElement(TableFillButton, { ref: handle, tableRef: ref, table: spec(rows), job: null, improvableRows: new Set<string>() }));
        await act(async () => handle.current!.openPlan({ kind: 'cells', rows: ['a'] }));
        expect(fills.plan).toHaveBeenCalledWith(ref, { kind: 'cells', rows: ['a'] });
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        render(React.createElement(TableFillButton, { ref: handle, tableRef: ref, table: spec(rows), job: running, improvableRows: new Set<string>() }));
        await act(async () => handle.current!.openPlan({ kind: 'cells', columns: ['method'] }));
        expect(fills.plan).toHaveBeenCalledTimes(1);
    });
});

describe('the refill alert', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => row(id, { method: answered }));
    const alert = () => container.querySelector('.bt-fill-refill');
    const open = async (shown: Partial<TableFillPlanSummary>) => {
        fills.plan.mockResolvedValueOnce({ ok: true, plan: { ...plan, rows: 7, documents: 7, credits: 1.4, ...shown } });
        render(React.createElement(TableFillButton, { tableRef: ref, table: spec(rows), job: null, improvableRows: new Set<string>() }));
        await act(async () => container.querySelector<HTMLButtonElement>('button.bt-fill-main')!.click());
    };

    it('says a changed column costs a whole fill, and puts the trial forward', async () => {
        await open({ rereads: 7 });
        expect(alert()?.textContent).toBe(
            'Each paper is read again, so filling one column costs as much as filling all of them. Finish your column changes first, then try 5 rows to check the answers.',
        );
        expect(buttonNamed('Try 5 first')!.className).toContain('variant-outline');
    });

    it('leaves the trial out of the alert when the fill is too small for one', async () => {
        await open({ rereads: 3, rows: 3, documents: 3 });
        expect(alert()?.textContent).toBe(
            'Each paper is read again, so filling one column costs as much as filling all of them. Finish your column changes first.',
        );
        expect(buttonNamed('Try 5 first')).toBeUndefined();
    });

    it('stays away from a fill that reads no answered paper again, and leaves the trial quiet', async () => {
        await open({ rereads: 0 });
        expect(alert()).toBeNull();
        expect(buttonNamed('Try 5 first')!.className).toContain('variant-ghost-secondary');
    });

    it('stays away from a retry of failed rows and from a trial', async () => {
        await open({ rereads: 2, scope: { kind: 'retry_failed' } });
        expect(alert()).toBeNull();
        act(() => root.unmount());
        root = createRoot(container);
        await open({ rereads: 5, rows: 5, scope: { kind: 'pending', limit: 5 } });
        expect(alert()).toBeNull();
    });
});

describe('TableFillBanner', () => {
    const outOfCredits: TableFillJobSnapshot = {
        ...running,
        state: 'done',
        rows_total: 3,
        result: {
            rows_answered: 0,
            answered: 0,
            not_reported: 0,
            from_title_abstract: 0,
            documents_read: 0,
            credits_charged: 0,
            row_failures: {},
            failed_row_ids: [],
            not_started: { insufficient_credits: 3 },
            stopped_by: 'insufficient_credits',
            not_written: 0,
            skipped_cells: {},
            pending: null,
        },
    };

    it('leads an out-of-credits result to credits, and says the rest wait', () => {
        setBalance(0);
        render(React.createElement(TableFillBanner, { job: outOfCredits, showingFailed: false, onShowFailed: vi.fn(), onDismiss: vi.fn() }));
        expect(container.textContent).toContain('Out of credits after 0 of 3 items · the rest stay pending');
        act(() => buttonNamed('Get credits')!.click());
        expect(mocks.openPreferencesWindow).toHaveBeenCalledWith('billing');
        setBalance(4);
        expect(buttonNamed('Add credits')).toBeDefined();
    });

    it('states the result, filters to the failed rows and dismisses', () => {
        const onShowFailed = vi.fn();
        const onDismiss = vi.fn();
        const done: TableFillJobSnapshot = {
            ...running,
            state: 'done',
            result: {
                rows_answered: 44,
                answered: 88,
                not_reported: 0,
                from_title_abstract: 0,
                documents_read: 44,
                credits_charged: 8.8,
                row_failures: { encrypted: 2 },
                failed_row_ids: ['x', 'y'],
                not_started: {},
                not_written: 0,
                skipped_cells: {},
                pending: null,
            },
        };
        render(React.createElement(TableFillBanner, { job: done, showingFailed: false, onShowFailed, onDismiss }));
        expect(container.textContent).toContain("Filled 44 of 46 items · 2 couldn't be read");
        act(() => buttonNamed('Show')!.click());
        expect(onShowFailed).toHaveBeenCalledWith(true);
        act(() => (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click());
        expect(onDismiss).toHaveBeenCalled();
    });
});

describe('the no-credits notice', () => {
    function Notice({ enabled }: { enabled: boolean }) {
        return useNoCreditsNotice(enabled);
    }
    const notice = () => container.querySelector('.bt-fill-banner');

    it('says filling needs credits and the table still works by hand, with a way to get them', () => {
        setBalance(0);
        render(React.createElement(Notice, { enabled: true }));
        expect(notice()?.textContent).toContain(
            'Filling uses Beaver credits, and you have none. You can still add rows and edit cells by hand.',
        );
        act(() => buttonNamed('Get credits')!.click());
        expect(mocks.openPreferencesWindow).toHaveBeenCalledWith('billing');
    });

    it('stays away with credits, an unknown balance, or while disabled', () => {
        setBalance(3);
        render(React.createElement(Notice, { enabled: true }));
        expect(notice()).toBeNull();
        setBalance(null);
        expect(notice()).toBeNull();
        setBalance(0);
        expect(notice()).not.toBeNull();
        render(React.createElement(Notice, { enabled: false }));
        expect(notice()).toBeNull();
    });

    it('stays dismissed for good', () => {
        setBalance(0);
        render(React.createElement(Notice, { enabled: true }));
        act(() => (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click());
        expect(notice()).toBeNull();
        expect(mocks.prefs.tableNoCreditsNoticeDismissed).toBe(true);
        act(() => root.unmount());
        root = createRoot(container);
        render(React.createElement(Notice, { enabled: true }));
        expect(notice()).toBeNull();
    });
});
