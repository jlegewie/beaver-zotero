import React, { useCallback, useRef, useState } from 'react';
import type { MenuPosition } from '../components/ui/menus/SearchMenu';

/** The character that opens the Add Sources menu from the chat editor. */
const TRIGGER = '@';

/**
 * Where the open menu's query starts inside the editor content.
 *
 * `prefix` is the text that preceded the trigger; everything after it (plus the
 * `@` itself, when there is one) is the typed query. A menu opened from the "+"
 * button has no `@` in the text, so it anchors on the content as it stood when
 * the button was clicked.
 */
export interface OpenTrigger {
    prefix: string;
    hasMarker: boolean;
}

/**
 * Whether a trailing `@` in `value` opens the menu, and the text it follows.
 *
 * Only a word-initial `@` counts, so an email address typed into the composer
 * stays plain text. Returns null when the value does not end in such an `@`.
 */
export function matchSourcesTrigger(value: string): { prefix: string } | null {
    if (!value.endsWith(TRIGGER)) return null;
    const charBefore = value.length > 1 ? value[value.length - 2] : null;
    if (charBefore !== null && charBefore !== ' ' && charBefore !== '\n') return null;
    return { prefix: value.slice(0, -1) };
}

/**
 * The query an open menu reads out of the editor's current text, or null when
 * the edit moved outside the query and the menu should close.
 */
export function queryForOpenTrigger(value: string, trigger: OpenTrigger): string | null {
    const prefix = trigger.prefix + (trigger.hasMarker ? TRIGGER : '');
    return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

/** Imperative surface the open menu exposes for keyboard handling. */
export interface AddSourcesMenuHandle {
    /** Leave a submenu for the top-level list. Returns false when already there. */
    goBack: () => boolean;
}

interface UseAddSourcesMenuOptions {
    verticalPosition: 'above' | 'below';
    /** Live editor text, read when the menu opens without a typed `@`. */
    contentRef: React.MutableRefObject<string>;
    /** Removes `length` characters from the end of the editor content. */
    deleteTrailingQuery: (length: number) => void;
    focusEditor: () => void;
    /**
     * Focuses the editor with the caret at the end of the content. The query is
     * always the tail of the document, so a menu opened without a typed `@`
     * has to put the caret there before the user types.
     */
    focusEditorAtEnd: () => void;
    setMessageContent: (value: string) => void;
    /** The rendered menu, for back-navigation out of a submenu. */
    menuRef: React.MutableRefObject<AddSourcesMenuHandle | null>;
}

/**
 * Drives the Add Sources menu from the chat editor, the way `useSlashMenu`
 * drives the actions menu: the caret never leaves the editor, and whatever the
 * user types after the `@` is the menu's search query.
 *
 * The menu closes on Escape, on a space typed as the first query character
 * (a later space is part of the query), when the `@` is deleted, when an item
 * is picked, and on any click outside it (handled by `SearchMenu` itself).
 */
export function useAddSourcesMenu({
    verticalPosition,
    contentRef,
    deleteTrailingQuery,
    focusEditor,
    focusEditorAtEnd,
    setMessageContent,
    menuRef,
}: UseAddSourcesMenuOptions) {
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [query, setQuery] = useState('');

    // Mirrors of the state above, so handlers that run within a single event
    // (keydown closing the menu, the input event that follows it) see the
    // current values rather than the ones from their render.
    const isOpenRef = useRef(false);
    const queryRef = useRef('');
    const triggerRef = useRef<OpenTrigger | null>(null);

    const open = useCallback((trigger: OpenTrigger, at: MenuPosition) => {
        triggerRef.current = trigger;
        queryRef.current = '';
        isOpenRef.current = true;
        setQuery('');
        setPosition(at);
        setIsOpen(true);
    }, []);

    const close = useCallback(() => {
        triggerRef.current = null;
        queryRef.current = '';
        isOpenRef.current = false;
        setQuery('');
        setIsOpen(false);
    }, []);

    /** Close and leave the typed text in the editor (Escape, outside click, …). */
    const dismiss = useCallback(() => {
        close();
    }, [close]);

    /**
     * Close because something was picked: the typed `@query` did its job as a
     * search box, so it is removed rather than left in the message.
     */
    const commit = useCallback(() => {
        const removeLength = queryRef.current.length + (triggerRef.current?.hasMarker ? 1 : 0);
        close();
        if (removeLength > 0) deleteTrailingQuery(removeLength);
        // The click that picked the item may have taken DOM focus out of the
        // editor; restore it once the menu has actually unmounted.
        setTimeout(() => focusEditor(), 0);
    }, [close, deleteTrailingQuery, focusEditor]);

    /** Drop the typed query but keep the menu open (entering a submenu). */
    const resetQuery = useCallback(() => {
        const length = queryRef.current.length;
        queryRef.current = '';
        setQuery('');
        if (length > 0) deleteTrailingQuery(length);
    }, [deleteTrailingQuery]);

    /** Open from the "+" button, anchoring the query to the current content. */
    const openFromButton = useCallback((at: MenuPosition) => {
        open({ prefix: contentRef.current, hasMarker: false }, at);
        // The menu renders no search input of its own, and the click that
        // opened it left focus on the button — so hand focus to the editor,
        // caret at the end, or the menu could not be searched at all. Deferred
        // until the menu has mounted: rendering it mutates the same chrome
        // document, which resets contenteditable selection offsets.
        setTimeout(() => focusEditorAtEnd(), 0);
    }, [contentRef, focusEditorAtEnd, open]);

    /** Detect a typed `@` trigger. Returns true when the menu opened. */
    const handleTrigger = useCallback((value: string, rect: DOMRect): boolean => {
        const match = matchSourcesTrigger(value);
        if (!match) return false;
        const y = verticalPosition === 'above' ? rect.top - 5 : rect.bottom - 10;
        open({ prefix: match.prefix, hasMarker: true }, { x: rect.left, y });
        setMessageContent(value);
        return true;
    }, [open, setMessageContent, verticalPosition]);

    /** Handle an editor change while the menu is open. Returns true if handled. */
    const handleChange = useCallback((value: string): boolean => {
        if (!isOpenRef.current) return false;
        const trigger = triggerRef.current;
        const nextQuery = trigger ? queryForOpenTrigger(value, trigger) : null;
        if (nextQuery !== null) {
            queryRef.current = nextQuery;
            setQuery(nextQuery);
        } else {
            // The `@` was deleted, or the edit landed somewhere else entirely.
            close();
        }
        setMessageContent(value);
        return true;
    }, [close, setMessageContent]);

    /**
     * Handle a keydown while the menu is open. Returns true when the event was
     * consumed.
     *
     * Navigation keys are only preventDefault'ed (never stopPropagation'ed):
     * the event must keep bubbling to `SearchMenu`'s document-level listener,
     * which performs the actual navigation and selection.
     */
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>): boolean => {
        if (!isOpenRef.current) return false;
        if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
            e.preventDefault();
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            dismiss();
            return true;
        }
        if (e.key === ' ' && queryRef.current.length === 0) {
            // A space right after the `@` means the user was not addressing the
            // menu. Let it type; only a later space belongs to the query.
            dismiss();
            return true;
        }
        if ((e.key === 'Backspace' || e.key === 'Delete') && queryRef.current.length === 0) {
            // Inside a submenu the empty-query Backspace steps back out of it
            // instead of deleting the `@` that opened the menu.
            if (menuRef.current?.goBack()) {
                e.preventDefault();
                return true;
            }
        }
        return false;
    }, [dismiss, menuRef]);

    return {
        isOpen,
        position,
        query,
        openFromButton,
        handleTrigger,
        handleChange,
        handleKeyDown,
        dismiss,
        commit,
        resetQuery,
    };
}
