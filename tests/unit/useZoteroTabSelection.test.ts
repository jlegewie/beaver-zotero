import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockSetIsLibraryTab,
    mockSetSelectedTabId,
    mockUseEffect,
    mockUseSetAtom,
    mockUseStore,
} = vi.hoisted(() => ({
    mockSetIsLibraryTab: vi.fn(),
    mockSetSelectedTabId: vi.fn(),
    mockUseEffect: vi.fn(),
    mockUseSetAtom: vi.fn(),
    mockUseStore: vi.fn(),
}));

vi.mock('react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react')>()),
    useEffect: mockUseEffect,
}));

vi.mock('jotai', async (importOriginal) => ({
    ...(await importOriginal<typeof import('jotai')>()),
    useSetAtom: mockUseSetAtom,
    useStore: mockUseStore,
}));

vi.mock('../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../react/ui/UIManager', () => ({
    uiManager: {
        updateUI: vi.fn(),
    },
}));

vi.mock('../../react/atoms/ui', () => ({
    isLibraryTabAtom: {},
    selectedZoteroTabIdAtom: {},
}));

vi.mock('../../react/atoms/composerFocus', () => ({
    pendingComposerFocusTransferAtom: {},
}));

interface TestDocument {
    activeElement: HTMLElement | null;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    querySelector: ReturnType<typeof vi.fn>;
}

function createHarness() {
    let tabObserver: { notify: (...args: any[]) => Promise<void> } | null = null;
    let pointerDown: ((event: PointerEvent) => void) | null = null;
    let pointerUp: (() => void) | null = null;
    let cleanup: (() => void) | undefined;
    let pendingTransfer: any = null;

    const document: TestDocument = {
        activeElement: null,
        addEventListener: vi.fn((type, listener) => {
            if (type === 'pointerdown') {
                pointerDown = listener as (event: PointerEvent) => void;
            } else if (type === 'pointerup') {
                pointerUp = listener as () => void;
            }
        }),
        removeEventListener: vi.fn(),
        querySelector: vi.fn().mockReturnValue(null),
    };
    const win = {
        document,
        setTimeout: (callback: () => void, delay: number) =>
            globalThis.setTimeout(callback, delay) as unknown as number,
        clearTimeout: (timer: number) =>
            globalThis.clearTimeout(timer as unknown as ReturnType<typeof setTimeout>),
        Zotero_Tabs: {
            selectedType: 'library',
            selectedID: 'zotero-pane',
            _tabs: [
                { id: 'reader-1', type: 'reader' },
                { id: 'reader-2', type: 'reader' },
            ],
        },
    };
    const store = {
        get: vi.fn(() => pendingTransfer),
        set: vi.fn((_atom, update) => {
            pendingTransfer = typeof update === 'function'
                ? update(pendingTransfer)
                : update;
        }),
    };

    mockUseEffect.mockImplementation((effect: () => void | (() => void)) => {
        cleanup = effect() ?? undefined;
    });
    mockUseSetAtom
        .mockReturnValueOnce(mockSetIsLibraryTab)
        .mockReturnValueOnce(mockSetSelectedTabId);
    mockUseStore.mockReturnValue(store);

    Object.assign(globalThis.Zotero, {
        getMainWindow: vi.fn(() => win),
        Notifier: {
            registerObserver: vi.fn((observer) => {
                tabObserver = observer;
                return 'tab-observer';
            }),
            unregisterObserver: vi.fn(),
        },
    });

    return {
        cleanup: () => cleanup?.(),
        document,
        getPendingTransfer: () => pendingTransfer,
        getPointerDown: () => pointerDown,
        getPointerUp: () => pointerUp,
        getTabObserver: () => tabObserver,
        win,
    };
}

async function registerSelection(
    element: HTMLElement,
    selection = { anchor: 7, focus: 7 },
) {
    const { registerComposerSelectionProvider } =
        await import('../../react/utils/composerSelection');
    registerComposerSelectionProvider(element, () => selection);
}

async function loadHook() {
    const { useZoteroTabSelection } =
        await import('../../react/hooks/useZoteroTabSelection');
    useZoteroTabSelection();
}

function composerElement() {
    return {
        matches: vi.fn().mockReturnValue(true),
    } as unknown as HTMLElement;
}

function nonComposerElement() {
    return {
        matches: vi.fn().mockReturnValue(false),
    } as unknown as HTMLElement;
}

function tabPointerEvent(tabId: string): PointerEvent {
    return {
        target: {
            closest: vi.fn().mockReturnValue({
                getAttribute: vi.fn().mockReturnValue(tabId),
            }),
        },
    } as unknown as PointerEvent;
}

describe('useZoteroTabSelection composer focus transfer', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('captures the active composer during a keyboard tab change', async () => {
        const harness = createHarness();
        const composer = composerElement();
        harness.document.activeElement = composer;
        await registerSelection(composer);

        await loadHook();
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-1'], {});

        expect(harness.getPendingTransfer()).toMatchObject({
            targetSurface: 'reader',
            selection: { anchor: 7, focus: 7 },
            deferred: false,
            restoreDelayMs: 50,
        });
        expect(harness.getPendingTransfer()).not.toHaveProperty('targetWindow');
        harness.cleanup();
        expect(harness.getPendingTransfer()).toBeNull();
    });

    it('uses a matching pointerdown snapshot after the Zotero tab takes focus', async () => {
        const harness = createHarness();
        const composer = composerElement();
        harness.document.activeElement = composer;
        await registerSelection(composer, { anchor: 9, focus: 3 });

        await loadHook();
        harness.getPointerDown()!(tabPointerEvent('reader-1'));
        harness.getPointerUp()!();
        harness.document.activeElement = nonComposerElement();
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-1'], {});

        expect(harness.getPendingTransfer()).toMatchObject({
            targetSurface: 'reader',
            selection: { anchor: 9, focus: 3 },
        });
        harness.cleanup();
    });

    it('does not reuse a pointer snapshot for a different tab', async () => {
        const harness = createHarness();
        const composer = composerElement();
        harness.document.activeElement = composer;
        await registerSelection(composer);

        await loadHook();
        harness.getPointerDown()!(tabPointerEvent('reader-1'));
        harness.document.activeElement = nonComposerElement();
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-2'], {});

        expect(harness.getPendingTransfer()).toBeNull();
        harness.cleanup();
    });

    it('expires a pointer snapshot when no tab selection follows', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        const composer = composerElement();
        harness.document.activeElement = composer;
        await registerSelection(composer);

        await loadHook();
        harness.getPointerDown()!(tabPointerEvent('reader-1'));
        harness.document.activeElement = nonComposerElement();
        vi.advanceTimersByTime(1_001);
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-1'], {});

        expect(harness.getPendingTransfer()).toBeNull();
        harness.cleanup();
    });

    it('clears a same-tab pointer snapshot when its gesture produces no selection', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        const composer = composerElement();
        harness.document.activeElement = composer;
        await registerSelection(composer);

        await loadHook();
        harness.getPointerDown()!(tabPointerEvent('reader-1'));
        harness.getPointerUp()!();
        harness.document.activeElement = nonComposerElement();
        vi.advanceTimersByTime(0);
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-1'], {});

        expect(harness.getPendingTransfer()).toBeNull();
        harness.cleanup();
    });

    it('defers an unloaded-reader transfer until its matching load event', async () => {
        const harness = createHarness();
        harness.win.Zotero_Tabs._tabs[0].type = 'reader-loading';
        const composer = composerElement();
        harness.document.activeElement = composer;
        await registerSelection(composer);

        await loadHook();
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-1'], {});
        expect(harness.getPendingTransfer()).toMatchObject({
            deferred: true,
        });

        harness.document.activeElement = nonComposerElement();
        harness.win.Zotero_Tabs.selectedID = 'reader-1';
        await harness.getTabObserver()!.notify('load', 'tab', ['reader-1'], {});
        expect(harness.getPendingTransfer()).toMatchObject({
            deferred: false,
            restoreDelayMs: 100,
        });
        harness.cleanup();
    });

    it('expires an unconsumed transfer', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        const composer = composerElement();
        harness.document.activeElement = composer;
        await registerSelection(composer);

        await loadHook();
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-1'], {});
        expect(harness.getPendingTransfer()).not.toBeNull();
        vi.advanceTimersByTime(5_001);

        expect(harness.getPendingTransfer()).toBeNull();
        harness.cleanup();
    });

    it('does not request a transfer when the composer did not own focus', async () => {
        const harness = createHarness();
        harness.document.activeElement = nonComposerElement();

        await loadHook();
        await harness.getTabObserver()!.notify('select', 'tab', ['reader-1'], {});

        expect(harness.getPendingTransfer()).toBeNull();
        harness.cleanup();
        expect(harness.document.removeEventListener).toHaveBeenCalledWith(
            'pointerdown',
            expect.any(Function),
            true,
        );
        expect(harness.document.removeEventListener).toHaveBeenCalledWith(
            'pointerup',
            expect.any(Function),
            true,
        );
    });
});
