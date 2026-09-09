// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ card: null as any, batch: null as string | null }));
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
vi.mock('@beaver/agent-ui/chat/BatchApprovalCard', () => ({
    default: ({ approval, onSubmit, titleTrailing }: any) => React.createElement(
        'div', { className: 'batch-card', 'data-approval': approval.approvalId },
        React.createElement('button', { type: 'button', onClick: () => onSubmit({ approved: true, mode: 'ask_each_time', user_instructions: null }) }, approval.approveLabel),
        titleTrailing,
    ),
}));
// The panel's stamp reading is its own test's business; here it draws a
// disclosure whenever the mock has a batch, controlled by the popup.
vi.mock('../../../../react/components/input/BatchProgressPanel', () => ({
    default: ({ expanded, onExpandedChange }: any) => mocks.batch
        ? React.createElement('div', { className: 'batch-bar', role: 'button', 'aria-expanded': expanded, onClick: () => onExpandedChange(!expanded) }, mocks.batch)
        : null,
}));
vi.mock('../../../../react/components/runStatusPopup/RunPulse', () => ({ default: () => null }));

import RunStatusPopup from '../../../../react/components/runStatusPopup/RunStatusPopup';

let store = createStore();
let root: Root;
let container: HTMLDivElement;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
    store = createStore();
    (window as any).ResizeObserver = class { observe() {} disconnect() {} };
    mocks.batch = null;
    mocks.card = {
        kind: 'approval', runId: 'run-1', threadName: 'Test', label: 'Create collection', stackDepth: 0,
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

describe('RunStatusPopup batch approval', () => {
    beforeEach(() => {
        mocks.card = {
            kind: 'batch', runId: 'run-1', threadName: 'Test', stackDepth: 0,
            approval: { approvalId: 'b1', approveLabel: 'Start batch' },
            onSubmit: vi.fn(), onOpen: vi.fn(), onDismiss: vi.fn(),
        };
    });
    it('draws the shared approval card alone, with the close button in its title row', () => {
        render();
        const card = container.querySelector<HTMLElement>('.batch-card')!;
        expect(card.dataset.approval).toBe('b1');
        expect(container.querySelector('.beaver-run-status-popup__header')).toBeNull();
        act(() => card.click());
        expect(mocks.card.onOpen).not.toHaveBeenCalled();
        act(() => card.querySelector('button')!.click());
        expect(mocks.card.onSubmit).toHaveBeenCalledWith({ approved: true, mode: 'ask_each_time', user_instructions: null });
        act(() => card.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
        expect(mocks.card.onDismiss).toHaveBeenCalledTimes(1);
        expect(mocks.card.onOpen).not.toHaveBeenCalled();
    });
});

describe('RunStatusPopup batch progress', () => {
    const running = (runId = 'run-1') => ({
        kind: 'running', runId, threadName: 'Test', statusLine: 'Filing items', stackDepth: 0,
        onOpen: vi.fn(), onDismiss: vi.fn(),
    });
    const bar = () => container.querySelector<HTMLElement>('.batch-bar');

    it('shows the progress on the working and approval cards only, and leaves it out with no batch', () => {
        mocks.card = running();
        render();
        expect(bar()).toBeNull();
        expect(container.querySelector('.beaver-run-status-popup__batch-progress')).not.toBeNull();

        mocks.batch = 'Filing items 12 of 184';
        render();
        expect(bar()?.textContent).toBe('Filing items 12 of 184');

        mocks.card = { ...mocks.card, kind: 'approval', label: 'Edit', approveLabel: 'Approve', rejectLabel: 'Reject', decideDisabled: false, onDecide: vi.fn() };
        render();
        expect(bar()).not.toBeNull();

        mocks.card = { ...running(), kind: 'credit', title: 'T', message: 'M', approveLabel: 'Continue', declineLabel: 'Wrap up', decideDisabled: false, onDecide: vi.fn() };
        render();
        expect(bar()).toBeNull();
    });

    it('keeps the disclosure open while the card changes under it, and folds it for the next run', () => {
        mocks.batch = 'Filing items';
        mocks.card = running();
        render();
        act(() => bar()!.click());
        expect(bar()?.getAttribute('aria-expanded')).toBe('true');
        expect(mocks.card.onOpen).not.toHaveBeenCalled();

        mocks.card = { ...running(), kind: 'approval', label: 'Edit', approveLabel: 'Approve', rejectLabel: 'Reject', decideDisabled: false, onDecide: vi.fn() };
        render();
        expect(bar()?.getAttribute('aria-expanded')).toBe('true');

        mocks.card = running('run-2');
        render();
        expect(bar()?.getAttribute('aria-expanded')).toBe('false');
    });
});
