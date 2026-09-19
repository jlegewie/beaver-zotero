// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).Zotero = { isMac: true };

let root: Root;
let container: HTMLDivElement;

const thread = { id: 'thread-1', name: 'Reading list', isPinned: false };

const mocks = vi.hoisted(() => ({
    history: null as any,
}));

vi.mock('jotai', () => ({ useAtomValue: () => null, useSetAtom: () => vi.fn() }));
vi.mock('../../../react/atoms/threads', () => ({ newThreadAtom: {} }));
vi.mock('../../../react/atoms/auth', () => ({ userAtom: {} }));
vi.mock('../../../react/atoms/profile', () => ({ creditPlanAtom: {}, hasCreditPlanAtom: {} }));
vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({ useSurfaceWindow: () => window }));
vi.mock('../../../react/hooks/useThreadHistory', () => ({ useThreadHistory: () => mocks.history }));
vi.mock('../../../react/hooks/useThreadHistoryScroll', () => ({
    useThreadHistoryScroll: () => ({ scrollRef: { current: null }, sentinelRef: { current: null } }),
}));
vi.mock('../../../react/components/ui/buttons/UserAccountMenuButton', () => ({ useAccountMenuItems: () => [] }));
vi.mock('../../../react/components/preferences/BillingSection', () => ({ formatPlanName: () => '' }));
vi.mock('../../../react/components/ChatLoadFailure', () => ({ default: () => null }));
vi.mock('../../../react/components/icons/icons', () => {
    const NullIcon = () => null;
    return { Icon: NullIcon, MoreHorizontalIcon: NullIcon, PlusSignIcon: NullIcon, SearchIcon: NullIcon, UserIcon: NullIcon, CancelIcon: NullIcon };
});
vi.mock('@beaver/agent-ui/icons/Spinner', () => ({ default: () => null }));
vi.mock('@beaver/agent-ui/primitives/MenuButton', () => ({ default: () => null }));
vi.mock('@beaver/agent-ui/primitives/Tooltip', () => ({ default: ({ children }: any) => children }));

import WindowNav from '../../../react/components/window/WindowNav';

const makeHistory = (overrides: Record<string, unknown> = {}) => ({
    searchQuery: '',
    setSearchQuery: vi.fn(),
    activeQuery: '',
    submitSearch: vi.fn(),
    isLoading: false,
    view: { error: null, hasMore: false },
    reload: vi.fn(),
    visibleRows: [thread],
    pinnedThreads: [],
    groups: [{ label: 'Today', threads: [thread] }],
    currentThreadId: null,
    isPinPending: () => false,
    selectThread: vi.fn(),
    togglePin: vi.fn(),
    renameThread: vi.fn(),
    deleteThread: vi.fn(),
    ...overrides,
});

const render = () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(WindowNav, { collapsed: false })));
};

const row = () => container.querySelector<HTMLElement>('[data-thread-id="thread-1"]')!;
const rowButton = () => row().querySelector<HTMLButtonElement>('.beaver-window-nav-row-button')!;
const menuButton = () => row().querySelector<HTMLButtonElement>('.beaver-window-nav-row-menu')!;
const menu = () => container.querySelector<HTMLElement>('[role="menu"]');

/** Sends a native right-click and reports whether the native menu was suppressed. */
const rightClick = (target: Element, x: number, y: number) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
};

/** Gives the trailing button a real box; jsdom lays nothing out. */
const placeMenuButton = () => {
    menuButton().getBoundingClientRect = () => ({
        left: 200, top: 30, right: 224, bottom: 54, width: 24, height: 24, x: 200, y: 30, toJSON: () => ({}),
    });
};

beforeEach(() => { mocks.history = makeHistory(); });
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.clearAllMocks(); });

describe('thread row menu', () => {
    it('opens the row menu at the pointer on right-click, suppressing the native menu', () => {
        render();
        expect(menu()).toBeNull();

        const suppressed = rightClick(rowButton(), 120, 240);

        expect(suppressed).toBe(true);
        expect(menu()).not.toBeNull();
        expect(menu()!.style.position).toBe('fixed');
        expect(menu()!.style.left).toBe('120px');
        expect(menu()!.style.top).toBe('240px');
        const labels = Array.from(menu()!.querySelectorAll('[role="menuitem"]')).map(el => el.getAttribute('aria-label'));
        expect(labels).toEqual(['Rename chat', 'Pin chat', 'Delete chat']);
        expect(row().classList.contains('beaver-window-nav-row-menu-open')).toBe(true);
    });

    it('hangs the menu under the trailing button when that button is clicked', () => {
        render();
        placeMenuButton();

        act(() => menuButton().click());

        expect(menu()).not.toBeNull();
        expect(menu()!.style.left).toBe('194px');
        expect(menu()!.style.top).toBe('59px');
        expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    });

    it('falls back to the button anchor for a keyboard-invoked context menu', () => {
        render();
        placeMenuButton();

        rightClick(rowButton(), 0, 0);

        expect(menu()!.style.left).toBe('194px');
        expect(menu()!.style.top).toBe('59px');
    });

    it('leaves an open menu in place when the right-click lands inside it', () => {
        render();
        rightClick(rowButton(), 120, 240);
        const item = menu()!.querySelector('[role="menuitem"]')!;

        const suppressed = rightClick(item, 300, 400);

        expect(suppressed).toBe(true);
        expect(menu()!.style.left).toBe('120px');
        expect(menu()!.style.top).toBe('240px');
    });

    it('offers no menu while the row\'s pin toggle is pending', () => {
        mocks.history = makeHistory({ isPinPending: () => true });
        render();

        const suppressed = rightClick(rowButton(), 120, 240);

        expect(suppressed).toBe(false);
        expect(menu()).toBeNull();
        expect(menuButton()).toBeNull();
    });
});
