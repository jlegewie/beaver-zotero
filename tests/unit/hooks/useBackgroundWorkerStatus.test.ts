// @vitest-environment jsdom
import { useEmbeddingIndex } from '../../../react/hooks/useEmbeddingIndex';
import { embeddingIndexStateAtom } from '../../../react/atoms/embeddingIndex';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BeaverInstance, type WindowRuntime } from '../../../src/runtime/instance';
import { useBackgroundWorkerStatus } from '../../../react/hooks/useBackgroundWorkerStatus';
import { isBackgroundWorkerRunningAtom } from '../../../react/atoms/backgroundExtraction';

const binding = vi.hoisted(() => ({ runtime: undefined as WindowRuntime | undefined }));
vi.mock('../../../react/runtime/windowRuntime', () => ({
    tryGetWindowRuntime: () => binding.runtime?.status === 'closing' ? undefined : binding.runtime,
}));
let instance: BeaverInstance;
let runtime: WindowRuntime;
let store = createStore();
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const getStatus = vi.fn(() => ({ running: true }));

function mount() {
    function Harness() { useBackgroundWorkerStatus(); return null; }
    act(() => root.render(React.createElement(Provider, { store }, React.createElement(Harness))));
}

beforeEach(() => {
    vi.clearAllMocks();
    instance = new BeaverInstance();
    runtime = instance.attachWindow(window);
    binding.runtime = undefined;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (Zotero as any).Beaver = { runtime: instance, backgroundExtractor: { getStatus } };
    store = createStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    instance.disposeInstance();
});

it('ignores an effect before runtime initialization', () => {
    expect(mount).not.toThrow();
    expect(getStatus).not.toHaveBeenCalled();
    expect(store.get(isBackgroundWorkerRunningAtom)).toBe(false);
});

it('subscribes while attaching, hydrates status, and stops receiving updates on unmount', () => {
    binding.runtime = runtime;
    mount();
    expect(store.get(isBackgroundWorkerRunningAtom)).toBe(true);
    act(() => instance.publish('background-worker:status', { running: false }));
    expect(store.get(isBackgroundWorkerRunningAtom)).toBe(false);
    act(() => root.render(null));
    act(() => instance.publish('background-worker:status', { running: true }));
    expect(store.get(isBackgroundWorkerRunningAtom)).toBe(false);
});

it('ignores a delayed effect after its runtime starts closing', () => {
    binding.runtime = runtime;
    instance.markClosing(runtime.hostWindow);
    expect(mount).not.toThrow();
    expect(getStatus).not.toHaveBeenCalled();
    act(() => instance.publish('background-worker:status', { running: true }));
    expect(store.get(isBackgroundWorkerRunningAtom)).toBe(false);
});

it('revokes embedding projections as soon as their runtime starts closing', () => {
    binding.runtime = runtime;
    const initial = { ...store.get(embeddingIndexStateAtom), totalItems: 9 };
    (Zotero as any).Beaver.background = { getSnapshot: () => initial };
    function IndexHarness() { useEmbeddingIndex(); return null; }
    act(() => root.render(React.createElement(Provider, { store }, React.createElement(IndexHarness))));
    expect(store.get(embeddingIndexStateAtom).totalItems).toBe(9);
    act(() => instance.publish('embedding-index:status', { ...initial, totalItems: 10 }));
    expect(store.get(embeddingIndexStateAtom).totalItems).toBe(10);
    instance.markClosing(runtime.hostWindow);
    act(() => instance.publish('embedding-index:status', { ...initial, totalItems: 99 }));
    expect(store.get(embeddingIndexStateAtom).totalItems).toBe(10);
});
