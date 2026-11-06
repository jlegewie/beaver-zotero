// @vitest-environment jsdom

/**
 * The table tab's Version history panel: the saved versions as a list grouped
 * by day with the current one marked, restoring a version from its row, and
 * the read-only, fill-running and failure states.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurfaceWindowContext } from '../../../react/runtime/SurfaceWindowContext';
import { TableVersionHistory, toVersionListEntry } from '../../../react/components/tables/TableVersionHistory';
import { setTablesApi, type TablesApi } from '../../../src/services/artifacts/tablesApi';
import type { TableVersionEntry } from '../../../src/services/artifacts/tableItemIdentity';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const h = React.createElement;
const ref = { libraryID: 1, key: 'TABLE001' };

const summary = (rows: number) =>
    ({
        rows,
        columns: 4,
        columns_detail: {
            _reference: { type: 'reference', system: true },
            _year: { type: 'date', system: true },
            effect: { type: 'text' },
            design: { type: 'select' },
        },
    }) as unknown as TableVersionEntry['summary'];

const entry = (version: number, at: string, extra: Partial<TableVersionEntry> = {}): TableVersionEntry =>
    ({ version, actor: 'user', at, sha256: 'x', summary: summary(version * 2), ...extra }) as TableVersionEntry;

const history = vi.fn();
const revert = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 5, 21, 0));
    history.mockResolvedValue([
        entry(1, new Date(2026, 10, 3, 10, 0).toISOString(), { actor: 'agent', change: 'Created the table' }),
        entry(2, new Date(2026, 10, 4, 15, 30).toISOString(), { change: 'Added column “Design”' }),
        entry(3, new Date(2026, 10, 5, 9, 5).toISOString(), { change: 'Added items' }),
    ]);
    revert.mockResolvedValue({ ok: true, version: 4, saved: true });
    setTablesApi({ local: { commands: () => ({ history, revert }) } } as unknown as TablesApi);
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    setTablesApi(null);
    vi.useRealTimers();
});

async function mount(props: Partial<React.ComponentProps<typeof TableVersionHistory>> = {}) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(
            h(
                SurfaceWindowContext.Provider,
                { value: window },
                h(TableVersionHistory, { tableRef: ref, currentVersion: 3, reloadKey: 0, readOnly: false, ...props }),
            ),
        );
    });
}

const entries = () => Array.from(container!.querySelectorAll<HTMLElement>('.rt-history-entry'));
const restoreButton = (version: number) =>
    container!.querySelector<HTMLButtonElement>(`.rt-history-entry[data-version="${version}"] .rt-history-restore`);

describe('the version list', () => {
    it('lists versions newest first under day headings, with what changed, who, and the size', async () => {
        await mount();
        expect(Array.from(container!.querySelectorAll('.rt-history-day-heading')).map((el) => el.textContent)).toEqual([
            'Today',
            'Yesterday',
            new Date(2026, 10, 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        ]);
        expect(entries().map((el) => el.dataset.version)).toEqual(['3', '2', '1']);
        expect(entries()[0].querySelector('.rt-history-change')!.textContent).toBe('Added items');
        const meta = entries()[2].querySelector('.rt-history-meta')!.textContent!;
        expect(meta).toContain('Beaver');
        expect(meta).toContain('2 items');
        // System columns (Reference, Year) are not counted.
        expect(meta).toContain('2 columns');
        expect(meta).toContain('v1');
    });

    it('marks the version the table shows as current, without a restore action', async () => {
        await mount();
        expect(entries()[0].classList.contains('rt-history-current')).toBe(true);
        expect(entries()[0].querySelector('.rt-history-badge')!.textContent).toBe('Current');
        expect(restoreButton(3)).toBeNull();
        expect(restoreButton(2)).not.toBeNull();
        expect(restoreButton(1)).not.toBeNull();
    });

    it('says so when the table has no saved versions', async () => {
        history.mockResolvedValueOnce([]);
        await mount();
        expect(container!.textContent).toContain('No saved versions yet.');
    });

    it('shows a load failure', async () => {
        history.mockRejectedValueOnce(new Error('Table file is missing on this device.'));
        await mount();
        expect(container!.querySelector('[role="alert"]')!.textContent).toBe('Table file is missing on this device.');
        expect(container!.textContent).not.toContain('Loading versions');
    });

    it('reloads when the tab re-reads the table', async () => {
        await mount();
        expect(history).toHaveBeenCalledTimes(1);
        await act(async () => {
            root!.render(
                h(
                    SurfaceWindowContext.Provider,
                    { value: window },
                    h(TableVersionHistory, { tableRef: ref, currentVersion: 3, reloadKey: 1, readOnly: false }),
                ),
            );
        });
        expect(history).toHaveBeenCalledTimes(2);
    });
});

describe('restoring a version', () => {
    it('restores the chosen version as a new one and reports it', async () => {
        await mount();
        await act(async () => restoreButton(2)!.click());
        expect(revert).toHaveBeenCalledWith(ref, 2);
        expect(container!.querySelector('[role="status"]')!.textContent).toBe('Restored version 2 as version 4.');
        expect(restoreButton(1)!.disabled).toBe(false);
    });

    it('disables every restore while one is in progress', async () => {
        let settle: (value: unknown) => void = () => {};
        revert.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
        await mount();
        await act(async () => restoreButton(2)!.click());
        expect(restoreButton(1)!.disabled).toBe(true);
        expect(restoreButton(2)!.parentElement!.classList.contains('rt-history-restoring')).toBe(true);
        expect(restoreButton(1)!.parentElement!.classList.contains('rt-history-restoring')).toBe(false);
        await act(async () => settle({ ok: true, version: 4, saved: true }));
        expect(restoreButton(1)!.disabled).toBe(false);
    });

    it('reports a conflict without claiming a restore', async () => {
        revert.mockResolvedValueOnce({ ok: false, conflict: true, version: 5, spec: null, sha256: null });
        await mount();
        await act(async () => restoreButton(1)!.click());
        expect(container!.querySelector('[role="alert"]')!.textContent).toContain('nothing was restored');
        expect(container!.querySelector('[role="status"]')).toBeNull();
    });

    it('asks the user to check the table when a restore failed mid-way', async () => {
        revert.mockRejectedValueOnce(new Error('Disk full'));
        await mount();
        await act(async () => restoreButton(1)!.click());
        expect(container!.querySelector('[role="alert"]')!.textContent).toBe(
            'Disk full Revert was not confirmed. Check the current table before trying again.',
        );
    });

    it('lists versions without restore actions in a read-only library', async () => {
        await mount({ readOnly: true });
        expect(entries()).toHaveLength(3);
        expect(container!.querySelector('.rt-history-restore')).toBeNull();
        expect(container!.textContent).toContain('read-only');
    });

    it('disables restoring with the reason while a fill runs', async () => {
        await mount({ restoreDisabledReason: 'A fill of this table is running.' });
        expect(restoreButton(1)!.disabled).toBe(true);
        expect(restoreButton(1)!.title).toBe('A fill of this table is running.');
    });
});

describe('toVersionListEntry', () => {
    it('tolerates an entry without a summary', () => {
        const listed = toVersionListEntry({ version: 1, actor: 'system', at: 'x', sha256: 'y' } as TableVersionEntry);
        expect(listed).toEqual({ version: 1, actor: 'system', at: 'x', change: undefined });
    });
});
