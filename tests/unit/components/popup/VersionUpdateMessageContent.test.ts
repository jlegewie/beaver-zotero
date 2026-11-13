// @vitest-environment jsdom

/**
 * Where a release note's showcase is drawn, in each of the note's layouts.
 */
import React, { act } from 'react';
import { Provider, createStore } from 'jotai';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    gate: null as string | null,
    usesBeaverModel: true,
    plusToolsPref: false,
    credits: 10,
    open: vi.fn(),
    dismiss: vi.fn(),
    runAction: vi.fn(),
    setPref: vi.fn(),
    openPreferences: vi.fn(),
    surfaceWindow: { name: 'surface' },
}));
vi.mock('../../../../react/atoms/chatAccess', async () => {
    const { atom } = await import('jotai');
    const { getPlusToolsAccess } = await import('../../../../react/utils/plusToolsAccess');
    return {
        plusToolsAccessAtom: atom(() => getPlusToolsAccess({
            gate: mocks.gate as any,
            usesBeaverModel: mocks.usesBeaverModel,
            plusToolsPref: mocks.plusToolsPref,
            credits: mocks.credits,
        })),
    };
});
vi.mock('../../../../react/atoms/actions', async () => {
    const { atom } = await import('jotai');
    return { actionsAtom: atom(() => [{ id: 'builtin-research-table', text: 'Create a table' }]) };
});
vi.mock('../../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return { requestPlusToolsAtom: atom(false) };
});
vi.mock('../../../../react/hooks/useActionRunner', () => ({
    useActionRunner: () => ({ runAction: mocks.runAction, isBusy: false }),
}));
vi.mock('../../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => mocks.surfaceWindow }));
vi.mock('../../../../react/ui/openPreferencesWindow', () => ({ openPreferencesWindow: mocks.openPreferences }));
vi.mock('../../../../src/utils/prefs', () => ({ getPref: vi.fn(), setPref: mocks.setPref }));
vi.mock('../../../../react/atoms/quickPrompt', async () => {
    const { atom } = await import('jotai');
    return { openQuickPromptAtom: atom(null, () => mocks.open()) };
});
vi.mock('../../../../react/events/eventManager', () => ({ eventManager: { dispatch: vi.fn() } }));
vi.mock('../../../../react/constants/versionShowcases', async () => {
    const React = await import('react');
    const Stub: React.FC = () => React.createElement('div', { 'data-showcase': 'quick-prompt' }, 'showcase');
    return { getVersionShowcase: (id?: string) => (id === 'quick-prompt' ? Stub : undefined) };
});

import { eventManager } from '../../../../react/events/eventManager';
import VersionUpdateMessageContent from '../../../../react/components/ui/popup/VersionUpdateMessageContent';
import type { PopupMessage } from '../../../../react/types/popupMessage';

let root: Root | null = null;
let container: HTMLDivElement;

function render(message: Partial<PopupMessage>, isFloating = false) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(React.createElement(Provider, { store: createStore() }, React.createElement(VersionUpdateMessageContent, {
            message: { id: 'm', type: 'version_update', version: '0.25.0', ...message } as PopupMessage,
            onDismiss: mocks.dismiss,
            isFloating,
        })));
    });
}

const showcases = () => container.querySelectorAll('[data-showcase]').length;
/** What comes before and after the showcase, in document order. */
const order = () => Array.from(container.querySelectorAll('[data-showcase], [data-order]')).map((el) => el.textContent);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.gate = null;
    mocks.usesBeaverModel = true;
    mocks.plusToolsPref = false;
    mocks.credits = 10;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).Zotero = { launchURL: vi.fn() };
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    container.remove();
    delete (globalThis as any).Zotero;
});

describe('VersionUpdateMessageContent', () => {
    it.each([
        [null, 'Try now', true],
        ['signed-out', 'Sign in to try', false],
        ['onboarding', 'Open Beaver', false],
        ['connecting', 'Open Beaver', false],
    ])('routes the quick prompt action when the gate is %s', (gate, label, opensPrompt) => {
        mocks.gate = gate as string | null;
        render({ primaryAction: { type: 'quick-prompt', label: 'Try now' } }, true);
        const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === label);
        expect(button).toBeDefined();
        act(() => { button!.click(); });
        expect(mocks.dismiss).toHaveBeenCalledOnce();
        if (opensPrompt) {
            expect(mocks.open).toHaveBeenCalledOnce();
            expect(eventManager.dispatch).not.toHaveBeenCalled();
        } else {
            expect(mocks.open).not.toHaveBeenCalled();
            expect(eventManager.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true });
        }
    });

    const tableAction = { type: 'stage-action', label: 'Try it', actionId: 'builtin-research-table', requiresPlusTools: true } as const;
    const clickButton = (label: string) => {
        const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === label);
        expect(button).toBeDefined();
        act(() => { button!.click(); });
    };

    it('opens Beaver with the action staged in this window for a user who can run it', () => {
        render({ primaryAction: tableAction }, true);
        clickButton('Try it');
        expect(mocks.dismiss).toHaveBeenCalledOnce();
        expect(eventManager.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true, skipAutoPopulate: true });
        expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'builtin-research-table' }), mocks.surfaceWindow);
        expect(mocks.setPref).not.toHaveBeenCalled();
    });

    it('turns Plus Tools on for an own-model user before staging the action, and says why', () => {
        mocks.usesBeaverModel = false;
        render({ primaryAction: tableAction }, true);
        expect(container.textContent).toContain('needs Plus Tools');
        clickButton('Turn on Plus Tools');
        expect(mocks.setPref).toHaveBeenCalledWith('requestPlusTools', true);
        expect(mocks.runAction).toHaveBeenCalledOnce();
    });

    it('sends a user without credits to Billing without staging anything', () => {
        mocks.credits = 0;
        render({ primaryAction: tableAction }, true);
        expect(container.textContent).toContain('you have none left');
        clickButton('Get credits');
        expect(mocks.openPreferences).toHaveBeenCalledWith('billing');
        expect(mocks.runAction).not.toHaveBeenCalled();
        expect(eventManager.dispatch).not.toHaveBeenCalled();
    });

    it('asks a signed-out user to sign in, opening Beaver without staging', () => {
        mocks.gate = 'signed-out';
        render({ primaryAction: tableAction }, true);
        clickButton('Sign in to try');
        expect(eventManager.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true });
        expect(mocks.runAction).not.toHaveBeenCalled();
    });

    it('defaults older releases to opening Beaver', () => {
        render({}, true);
        act(() => { Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Open Beaver')!.click(); });
        expect(eventManager.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true });
    });

    it('opens a release-specific URL with its configured label', () => {
        render({ primaryAction: { type: 'open-url', label: 'Explore', url: 'https://example.test/feature' } }, true);
        act(() => { Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Explore')!.click(); });
        expect(Zotero.launchURL).toHaveBeenCalledWith('https://example.test/feature');
        expect(mocks.dismiss).toHaveBeenCalledOnce();
    });

    it('draws the showcase under the intro of a floating note, above its feature list', () => {
        render({ title: 'T', text: 'Intro', featureList: [{ title: 'Feature' }], showcase: 'quick-prompt' }, true);
        expect(showcases()).toBe(1);
        const text = container.textContent ?? '';
        expect(text.indexOf('Intro')).toBeLessThan(text.indexOf('showcase'));
        expect(text.indexOf('showcase')).toBeLessThan(text.indexOf('Feature'));
    });

    it('draws it in an in-panel note, with or without text beside it', () => {
        render({ text: 'Intro', showcase: 'quick-prompt' });
        expect(showcases()).toBe(1);
        act(() => { root?.unmount(); });
        container.remove();

        render({ showcase: 'quick-prompt' });
        expect(showcases()).toBe(1);
    });

    it('draws a step tour\'s showcases: the note\'s above the tour, a step\'s inside its step', () => {
        render({
            subtitle: 'Sub',
            showcase: 'quick-prompt',
            steps: [{ title: 'One', showcase: 'quick-prompt' }, { title: 'Two' }],
        });
        expect(showcases()).toBe(2);

        act(() => { container.querySelector<HTMLButtonElement>('.step-indicator-dot:nth-child(2)')?.click(); });
        expect(container.textContent).toContain('Two');
        expect(showcases()).toBe(1);
    });

    it('draws nothing extra for a note without one', () => {
        render({ title: 'T', text: 'Intro' }, true);
        expect(showcases()).toBe(0);
        expect(order()).toEqual([]);
    });
});
