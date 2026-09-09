// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRunFocusHandoff } from '../../../../react/components/quickPrompt/useRunFocusHandoff';

let root: Root;
let container: HTMLDivElement;
let host: HTMLDivElement;
let start: ReturnType<typeof useRunFocusHandoff>;
let options: Parameters<typeof useRunFocusHandoff>[0];
const restore = vi.fn();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function Harness() {
    start = useRunFocusHandoff(options);
    return null;
}
function render() { act(() => root.render(React.createElement(Harness))); }
function request() { act(() => start(host, restore)); }
function addCard(target: HTMLElement = host) {
    const card = target.ownerDocument.createElement('div');
    card.className = 'beaver-run-status-popup__card';
    card.tabIndex = 0;
    target.appendChild(card);
    return card;
}
beforeEach(() => {
    vi.useFakeTimers();
    restore.mockClear();
    options = { navigationKey: '1:library', enabled: true, sidebarVisible: false, isPending: true, runId: null };
    container = document.createElement('div');
    host = document.createElement('div');
    document.body.append(container, host);
    root = createRoot(container);
    render();
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    host.remove();
    vi.useRealTimers();
});
it('focuses the approval button when the sent run arrives', () => {
    request();
    const card = addCard();
    const approve = document.createElement('button');
    approve.setAttribute('data-run-status-approve', '');
    card.appendChild(approve);
    options = { ...options, runId: 'run-1' };
    render();
    expect(document.activeElement).toBe(approve);
    expect(restore).not.toHaveBeenCalled();
});
it('restores focus at the deadline and never focuses a later card', () => {
    request();
    act(() => vi.advanceTimersByTime(5000));
    expect(restore).toHaveBeenCalledOnce();
    const card = addCard();
    options = { ...options, runId: 'later-run' };
    render();
    expect(document.activeElement).not.toBe(card);
});
it('restores focus if sending ends without a run', () => {
    request();
    options = { ...options, isPending: false };
    render();
    expect(restore).toHaveBeenCalledOnce();
});
it('restores focus if popups are disabled while waiting', () => {
    request();
    options = { ...options, enabled: false };
    render();
    expect(restore).toHaveBeenCalledOnce();
});
it.each(['navigation', 'sidebar', 'input', 'window blur'])('cancels on %s without stealing focus later', (reason) => {
    request();
    if (reason === 'navigation') options = { ...options, navigationKey: '2:library' };
    if (reason === 'sidebar') options = { ...options, sidebarVisible: true };
    if (reason === 'window blur') act(() => { window.dispatchEvent(new Event('blur')); });
    if (reason === 'input') act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); });
    render();
    const card = addCard();
    options = { ...options, sidebarVisible: false, runId: 'later-run' };
    render();
    act(() => vi.advanceTimersByTime(5000));
    expect(document.activeElement).not.toBe(card);
    expect(restore).not.toHaveBeenCalled();
});
it('only considers cards in the requesting window', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const otherCard = addCard(frame.contentDocument!.body);
    request();
    options = { ...options, runId: 'run-1' };
    render();
    expect(frame.contentDocument!.activeElement).not.toBe(otherCard);
    const ownCard = addCard();
    render();
    // The observer sees the local card on the next microtask.
    return act(async () => {
        await Promise.resolve();
        expect(document.activeElement).toBe(ownCard);
        frame.remove();
    });
});
it('disconnects pending work when its window unmounts', () => {
    request();
    act(() => root.unmount());
    const card = addCard();
    act(() => vi.advanceTimersByTime(5000));
    expect(restore).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(card);
    root = createRoot(container);
});
