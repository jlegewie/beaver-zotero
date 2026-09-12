// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { execFileSync } from 'node:child_process';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { usePdfFetchStatus } from '../../../react/hooks/useBackgroundTasks';

it('observes plugin-bundle tasks from two renderer subscribers and hydrates late mounts', async () => {
    const bundle = execFileSync('node_modules/.bin/esbuild', ['src/utils/backgroundTasks.ts', '--bundle', '--format=iife', '--global-name=tasks', '--platform=browser'], { encoding: 'utf8' });
    let timestamp = 0;
    const plugin = createContext({ AbortController, setTimeout, clearTimeout, Date: { now: () => ++timestamp } });
    runInContext(bundle, plugin);
    const source = plugin.tasks.createBackgroundTaskSource();
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    const subscribe = source.subscribeToTasks;
    source.subscribeToTasks = (listener: any) => {
        const unsubscribe = vi.fn(subscribe(listener));
        unsubscribes.push(unsubscribe);
        return unsubscribe;
    };
    (Zotero as any).Beaver = { backgroundTasks: source };
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const containers = [document.createElement('div'), document.createElement('div')];
    const roots = containers.map(container => createRoot(container));
    function Status() {
        const status = usePdfFetchStatus(1, 'ITEMAAAA');
        return React.createElement('span', null, status.isLoading ? 'Fetching PDF…' : status.error ?? 'Done');
    }
    let finish!: () => void;
    try {
        act(() => roots[0].render(React.createElement(Status)));
        expect(containers[0].textContent).toBe('Done');
        act(() => plugin.tasks.scheduleBackgroundTask('pdf', 'pdf_fetch', () => new Promise<void>(resolve => { finish = resolve; }), { libraryId: 1, itemKey: 'ITEMAAAA' }));
        expect(containers[0].textContent).toBe('Fetching PDF…');
        act(() => roots[1].render(React.createElement(Status)));
        expect(containers[1].textContent).toBe('Fetching PDF…');
        await act(async () => { finish(); });
        expect(containers.map(container => container.textContent)).toEqual(['Done', 'Done']);
        await act(async () => plugin.tasks.scheduleBackgroundTask('failed', 'pdf_fetch', async () => { throw new Error('PDF unavailable'); }, { libraryId: 1, itemKey: 'ITEMAAAA' }));
        expect(containers.map(container => container.textContent)).toEqual(['PDF unavailable', 'PDF unavailable']);
    } finally {
        act(() => roots.forEach(root => root.unmount()));
        plugin.tasks.cancelAllActiveTasks();
    }
    expect(unsubscribes).toHaveLength(2);
    unsubscribes.forEach(unsubscribe => expect(unsubscribe).toHaveBeenCalledOnce());
});
