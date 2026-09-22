import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { newThreadAtom, ThreadData } from '../../atoms/threads';
import { userAtom } from '../../atoms/auth';
import { creditPlanAtom, hasCreditPlanAtom } from '../../atoms/profile';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import { useThreadHistory } from '../../hooks/useThreadHistory';
import { useThreadHistoryScroll } from '../../hooks/useThreadHistoryScroll';
import { useAccountMenuItems } from '../ui/buttons/UserAccountMenuButton';
import { formatPlanName } from '../preferences/BillingSection';
import { highlightMatch } from '../../utils/highlightMatch';
import ChatLoadFailure from '../ChatLoadFailure';
import { Icon, MoreHorizontalIcon, PlusSignIcon, SearchIcon, UserIcon, CancelIcon } from '../icons/icons';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import ContextMenu, { MenuItem, MenuPosition } from '@beaver/agent-ui/primitives/ContextMenu';

const UNNAMED_CHAT = 'Unnamed conversation';

interface RenameInputProps {
    name: string;
    onCommit: (name: string) => void;
    onCancel: () => void;
}

/** The inline rename field. Mounted only while a row is being renamed. */
const RenameInput: React.FC<RenameInputProps> = ({ name, onCommit, onCancel }) => {
    const [draft, setDraft] = useState(name);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const commit = () => {
        const next = draft.trim();
        if (next && next !== name) onCommit(next);
        else onCancel();
    };

    return (
        <div className="beaver-window-nav-row beaver-window-nav-row-editing">
            <input
                ref={inputRef}
                type="text"
                className="beaver-window-nav-rename"
                value={draft}
                aria-label="Chat name"
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); commit(); }
                    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                }}
            />
        </div>
    );
};

interface ThreadRowProps {
    thread: ThreadData;
    isCurrent: boolean;
    query: string;
    pinPending: boolean;
    onSelect: (thread: ThreadData) => void;
    onTogglePin: (thread: ThreadData) => void;
    onStartRename: (thread: ThreadData) => void;
    onDelete: (thread: ThreadData) => void;
}

/**
 * One chat in the history. The row itself opens the chat; rename, pin and
 * delete live in a menu opened from the trailing button or by right-clicking
 * anywhere on the row.
 */
const ThreadRow: React.FC<ThreadRowProps> = ({
    thread,
    isCurrent,
    query,
    pinPending,
    onSelect,
    onTogglePin,
    onStartRename,
    onDelete,
}) => {
    const name = thread.name || UNNAMED_CHAT;
    // Menus render inline, so the row must stay "hovered" while its menu is
    // open even when the pointer travels into the menu.
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const menuButtonRef = useRef<HTMLButtonElement | null>(null);

    // While a pin toggle is in flight the button gives way to a spinner, and
    // the menu is unavailable from either opener.
    const menuAvailable = !pinPending;

    /** Opens the menu hanging under the trailing button, as a click on it does. */
    const openMenuAtButton = () => {
        const rect = menuButtonRef.current?.getBoundingClientRect();
        if (!rect) return;
        // Under the pointer, which is on the button's right half.
        setMenuPosition({ x: rect.left - 6, y: rect.bottom + 5 });
        setMenuOpen(true);
    };

    const handleMenuButtonClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        openMenuAtButton();
        // The menu takes focus; the button must not keep its focus ring.
        menuButtonRef.current?.blur();
    };

    /**
     * Right-click anywhere on the row opens the same menu at the pointer, in
     * place of the native context menu. A keyboard-invoked context menu
     * (Shift+F10, the Menu key) reports no pointer position, so it falls back
     * to the button anchor.
     */
    const handleContextMenu = (e: React.MouseEvent) => {
        if (!menuAvailable) return;
        e.preventDefault();
        e.stopPropagation();
        // The open menu is a child of the row; a right-click on it must not
        // drag the menu under the pointer.
        if ((e.target as Element).closest('[role="menu"]')) return;
        if (e.clientX === 0 && e.clientY === 0) {
            openMenuAtButton();
            return;
        }
        setMenuPosition({ x: e.clientX, y: e.clientY });
        setMenuOpen(true);
    };

    // A truncated name scrolls slowly to its end while the row is hovered, so
    // the whole name can be read without opening the chat. The distance is
    // measured on enter and handed to CSS, which animates it at a fixed pace.
    const nameRef = useRef<HTMLSpanElement | null>(null);
    const handleRowEnter = () => {
        const el = nameRef.current;
        if (!el) return;
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow <= 0) return;
        // Past the hover fade under the row's menu button, so the end is legible.
        const distance = overflow + 36;
        el.style.setProperty('--beaver-nav-name-overflow', `${distance}px`);
        el.style.setProperty('--beaver-nav-name-scroll-duration', `${Math.max(1.5, distance / 30)}s`);
        el.classList.add('beaver-window-nav-row-name-scrolling');
    };
    const handleRowLeave = () => {
        nameRef.current?.classList.remove('beaver-window-nav-row-name-scrolling');
    };

    const menuItems: MenuItem[] = [
        {
            label: 'Rename chat',
            onClick: () => onStartRename(thread),
        },
        {
            label: thread.isPinned ? 'Unpin chat' : 'Pin chat',
            onClick: () => onTogglePin(thread),
            disabled: pinPending,
        },
        {
            label: 'row-divider',
            onClick: () => {},
            isDivider: true,
        },
        {
            label: 'Delete chat',
            onClick: () => onDelete(thread),
        },
    ];

    return (
        <div
            className={`beaver-window-nav-row ${isCurrent ? 'beaver-window-nav-row-current' : ''} ${menuOpen ? 'beaver-window-nav-row-menu-open' : ''}`}
            data-thread-id={thread.id}
            onMouseEnter={handleRowEnter}
            onMouseLeave={handleRowLeave}
            onContextMenu={handleContextMenu}
        >
            <button
                type="button"
                className="beaver-window-nav-button beaver-window-nav-row-button"
                aria-current={isCurrent ? 'page' : undefined}
                title={name}
                onClick={() => onSelect(thread)}
                onDoubleClick={() => onStartRename(thread)}
            >
                <span className="beaver-window-nav-row-name" ref={nameRef}>
                    <span className="beaver-window-nav-row-name-text">{highlightMatch(name, query)}</span>
                </span>
            </button>
            <div className="beaver-window-nav-row-actions">
                {menuAvailable ? (
                    <button
                        type="button"
                        ref={menuButtonRef}
                        className="variant-ghost-secondary icon-only beaver-window-nav-row-menu"
                        aria-label={`Actions for ${name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={handleMenuButtonClick}
                    >
                        <Icon icon={MoreHorizontalIcon} />
                    </button>
                ) : (
                    <span className="beaver-window-nav-row-spinner"><Spinner size={12} /></span>
                )}
            </div>
            {/* Outside the actions container, whose hover-only opacity and
                pointer events must not apply to the menu. */}
            <ContextMenu
                menuItems={menuItems}
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                position={menuPosition}
                useFixedPosition={true}
            />
        </div>
    );
};

interface WindowNavProps {
    /** Whether the sidebar is collapsed; its content is made inert while it is. */
    collapsed: boolean;
}

/**
 * The separate window's sidebar: new chat, chat search, pinned and recent
 * chats, and the account at the bottom.
 */
const WindowNav: React.FC<WindowNavProps> = ({ collapsed }) => {
    const surfaceWindow = useSurfaceWindow();
    const newThread = useSetAtom(newThreadAtom);
    const history = useThreadHistory();
    const { scrollRef, sentinelRef } = useThreadHistoryScroll(history, !collapsed);
    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);

    const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            history.setSearchQuery('');
            e.currentTarget.blur();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            history.submitSearch();
        }
    };

    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';

    const renderRow = (thread: ThreadData) => (
        editingThreadId === thread.id ? (
            <RenameInput
                key={thread.id}
                name={thread.name || UNNAMED_CHAT}
                onCommit={name => { setEditingThreadId(null); void history.renameThread(thread.id, name); }}
                onCancel={() => setEditingThreadId(null)}
            />
        ) : (
            <ThreadRow
                key={thread.id}
                thread={thread}
                isCurrent={thread.id === history.currentThreadId}
                query={history.activeQuery}
                pinPending={history.isPinPending(thread.id)}
                onSelect={t => { void history.selectThread(t); }}
                onTogglePin={history.togglePin}
                onStartRename={t => setEditingThreadId(t.id)}
                onDelete={t => { void history.deleteThread(t.id); }}
            />
        )
    );

    const hasRows = history.visibleRows.length > 0 || history.pinnedThreads.length > 0;
    const showEmpty = !history.isLoading && !hasRows && !history.view.error;

    return (
        <nav
            className="beaver-window-nav-content"
            aria-label="Chat history"
            aria-hidden={collapsed}
            // @ts-expect-error `inert` is not in React's attribute typings for this React version.
            inert={collapsed ? '' : undefined}
        >
            {/* Primary action */}
            <div className="beaver-window-nav-top">
                <Tooltip content="New chat" secondaryContent={newChatShortcut} showArrow singleLine>
                    <button
                        type="button"
                        className="beaver-window-nav-button beaver-window-nav-item"
                        onClick={() => { void newThread({ window: surfaceWindow }); }}
                    >
                        <Icon icon={PlusSignIcon} aria-hidden="true" focusable="false" />
                        <span className="truncate">New chat</span>
                    </button>
                </Tooltip>
            </div>

            {/* Search */}
            <div className="beaver-window-nav-search">
                <SearchIcon width={14} height={14} className="beaver-window-nav-search-icon" aria-hidden="true" />
                <input
                    ref={searchInputRef}
                    type="text"
                    className="beaver-window-nav-search-input"
                    placeholder="Search chats"
                    aria-label="Search chats"
                    value={history.searchQuery}
                    onChange={e => history.setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                />
                {history.isLoading ? (
                    <span className="beaver-window-nav-search-trailing"><Spinner size={12} /></span>
                ) : history.searchQuery ? (
                    <button
                        type="button"
                        className="beaver-window-nav-search-trailing beaver-window-nav-search-clear"
                        aria-label="Clear search"
                        onClick={() => { history.setSearchQuery(''); searchInputRef.current?.focus(); }}
                    >
                        <CancelIcon width={12} height={12} />
                    </button>
                ) : null}
            </div>

            {/* History */}
            <div className="beaver-window-nav-scroll scrollbar" ref={scrollRef}>
                {history.pinnedThreads.length > 0 && (
                    <section className="beaver-window-nav-group" aria-label="Pinned chats">
                        <div className="beaver-window-nav-group-label">Pinned</div>
                        {history.pinnedThreads.map(renderRow)}
                    </section>
                )}
                {history.groups.map((group, index) => (
                    <section key={group.label} className="beaver-window-nav-group" aria-label={`${group.label} chats`}>
                        <div className="beaver-window-nav-group-label">
                            {history.activeQuery && index === 0 ? 'Results' : group.label}
                        </div>
                        {group.threads.map(renderRow)}
                    </section>
                ))}

                {history.view.error && !history.isLoading && (
                    <div className="px-2">
                        <ChatLoadFailure error={history.view.error} retry={history.reload} />
                    </div>
                )}

                {showEmpty && (
                    <div className="beaver-window-nav-empty">
                        {history.activeQuery ? 'No matching chats' : 'No chats yet'}
                    </div>
                )}

                {history.isLoading && !hasRows && (
                    <div className="beaver-window-nav-empty"><Spinner size={16} /></div>
                )}

                <div ref={sentinelRef} style={{ minHeight: history.view.hasMore ? 32 : 1 }}>
                    {history.isLoading && hasRows && (
                        <div className="display-flex items-center justify-center py-2" role="status" aria-label="Loading more chats">
                            <Spinner size={16} />
                        </div>
                    )}
                </div>
            </div>

            <WindowAccountFooter />
        </nav>
    );
};

/**
 * The signed-in account at the foot of the sidebar. Clicking it opens the same
 * menu as the header's account button.
 */
const WindowAccountFooter: React.FC = () => {
    const user = useAtomValue(userAtom);
    const creditPlan = useAtomValue(creditPlanAtom);
    const hasCreditPlan = useAtomValue(hasCreditPlanAtom);
    const menuItems = useAccountMenuItems();

    const planLabel = hasCreditPlan ? `${formatPlanName(creditPlan.plan ?? undefined)} plan` : 'No active plan';
    const initial = user?.email?.trim().charAt(0) || '?';

    return (
        <div className="beaver-window-nav-footer">
            {user ? (
                <MenuButton
                    menuItems={menuItems}
                    variant="ghost"
                    className="beaver-window-nav-button beaver-window-nav-account"
                    ariaLabel={`Account ${user.email}, ${planLabel}. Open account menu`}
                    // The footer sits at the window's bottom edge, so the menu
                    // always flips upward; anchor it above the button instead of
                    // over it.
                    positionAdjustment={{ y: -58 }}
                    customContent={(
                        <span className="beaver-window-nav-account-content" aria-hidden="true">
                            <span className="beaver-window-nav-avatar">{initial}</span>
                            <span className="display-flex flex-col min-w-0 flex-1">
                                <span className="beaver-window-nav-account-email truncate">{user.email}</span>
                                <span className="beaver-window-nav-account-plan truncate">{planLabel}</span>
                            </span>
                        </span>
                    )}
                />
            ) : (
                <div className="beaver-window-nav-account-content" style={{ padding: '6px 8px' }}>
                    <span className="beaver-window-nav-avatar"><Icon icon={UserIcon} /></span>
                    <span className="beaver-window-nav-account-plan">Not signed in</span>
                </div>
            )}
        </div>
    );
};

export default WindowNav;
