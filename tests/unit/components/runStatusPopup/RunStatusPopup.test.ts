// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ card: null as any }));
vi.mock('../../../../react/components/runStatusPopup/useRunStatusPopupCard', () => ({
    useRunStatusPopupCard: () => mocks.card,
}));
vi.mock('../../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return { isSidebarVisibleAtom: atom(false) };
});
vi.mock('../../../../react/atoms/runStatusPopup', async () => {
    const { atom } = await import('jotai');
    return { runStatusPopupForceVisibleAtom: atom(false) };
});
vi.mock('../../../../react/host/zotero/components/agentActionViewHelpers', () => ({ getAgentActionToolIcon: () => () => null }));
vi.mock('../../../../react/components/ui/buttons/RunPermissionButton', () => ({ default: () => null }));
vi.mock('@beaver/agent-ui/chat/AskUserQuestionCard', () => ({ default: () => null }));
vi.mock('../../../../react/components/runStatusPopup/RunPulse', () => ({ default: () => null }));

import RunStatusPopup from '../../../../react/components/runStatusPopup/RunStatusPopup';

let store = createStore();
let root: Root;
let container: HTMLDivElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
    store = createStore();
    (window as any).ResizeObserver = class { observe() {} disconnect() {} };
    mocks.card = {
        kind: 'approval', threadName: 'Test', label: 'Create collection', stackDepth: 0,
        approveLabel: 'Approve', rejectLabel: 'Reject', decideDisabled: false,
        onOpen: vi.fn(), onDecide: vi.fn(), onDismiss: vi.fn(),
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});
function render() {
    act(() => root.render(React.createElement(Provider, { store }, React.createElement(RunStatusPopup))));
    return container.querySelector<HTMLElement>('.beaver-run-status-popup__card')!;
}
function press(target: HTMLElement, options: KeyboardEventInit = {}) {
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })); });
}
describe('RunStatusPopup keyboard decisions', () => {
    it('gives the card background the same Open Beaver action for mouse and keyboard', () => {
        const card = render();
        press(card);
        act(() => card.click());
        expect(card.getAttribute('aria-label')).toBe('Open Beaver: Test');
        expect(mocks.card.onOpen).toHaveBeenCalledTimes(2);
        expect(mocks.card.onDecide).not.toHaveBeenCalled();
    });
    it('moves focus from a running card to its approval button when approval arrives', () => {
        const approval = mocks.card;
        mocks.card = { ...approval, kind: 'running', statusLine: 'Thinking' };
        render().focus();
        mocks.card = approval;
        render();
        const button = container.querySelector<HTMLButtonElement>('[data-run-status-approve]')!;
        expect(document.activeElement).toBe(button);
        act(() => button.click());
        expect(approval.onDecide).toHaveBeenCalledWith(true);
        expect(approval.onOpen).not.toHaveBeenCalled();
    });
    it('ignores composing and repeated keyboard events', () => {
        press(render(), { isComposing: true });
        press(render(), { repeat: true });
        expect(mocks.card.onDecide).not.toHaveBeenCalled();
        expect(mocks.card.onOpen).not.toHaveBeenCalled();
    });
    it('leaves keyboard events on child controls to those controls', () => {
        render();
        press(Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Reject')!);
        expect(mocks.card.onDecide).not.toHaveBeenCalled();
        expect(mocks.card.onOpen).not.toHaveBeenCalled();
    });
});
