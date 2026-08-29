import React, { useCallback, useRef, useState } from 'react';
import type { MenuPosition, SearchMenuCloseReason } from '../primitives/SearchMenu';
import { getCaretRectWithin } from './caretNavigation';

/** The character that opens the Add Sources menu from the chat editor. */
const TRIGGER = '@';

/**
 * Where the open menu takes its search query from.
 *
 * - `editor` — the user typed `@`: the caret never leaves the composer and the
 *   text after the `@` is the query.
 * - `menu` — the menu was opened from the "+" button and renders its own
 *   focused search field, leaving the composer text untouched.
 */
export type AddSourcesQuerySource = 'editor' | 'menu';

/**
 * Where an editor-driven menu's query starts inside the editor content.
 *
 * `prefix` is the text that preceded the `@`; everything after `prefix@` is the
 * typed query.
 */
export interface OpenTrigger {
    prefix: string;
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
    const prefix = trigger.prefix + TRIGGER;
    return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

/** Imperative surface the open menu exposes for keyboard handling. */
export interface AddSourcesMenuHandle {
    /** Leave a submenu for the top-level list. Returns false when already there. */
    goBack: () => boolean;
}

interface UseAddSourcesMenuOptions {
    verticalPosition: 'above' | 'below';
    /** Removes `length` characters from the end of the editor content. */
    deleteTrailingQuery: (length: number) => void;
    focusEditor: () => void;
    setMessageContent: (value: string) => void;
    /** The rendered menu, for back-navigation out of a submenu. */
    menuRef: React.MutableRefObject<AddSourcesMenuHandle | null>;
}

/**
 * Drives the Add Sources menu, which searches from one of two places depending
 * on how it was opened (see `AddSourcesQuerySource`).
 *
 * A typed `@` works the way `useSlashMenu` drives the actions menu: the caret
 * never leaves the editor, and whatever follows the `@` is the query. Such a
 * menu closes on Escape, on a space typed as the first query character (a later
 * space is part of the query), when the `@` is deleted, when an item is picked,
 * and on any click outside it (handled by `SearchMenu` itself).
 *
 * The "+" button instead opens a menu with its own focused search field, so
 * none of the editor-driven handling applies: the composer keeps its text and
 * its caret, and every keystroke goes to the menu's field.
 */
export function useAddSourcesMenu({
    verticalPosition,
    deleteTrailingQuery,
    focusEditor,
    setMessageContent,
    menuRef,
}: UseAddSourcesMenuOptions) {
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [query, setQueryValue] = useState('');
    const [querySource, setQuerySourceValue] = useState<AddSourcesQuerySource>('editor');

    // Mirrors of the state above, so handlers that run within a single event
    // (keydown closing the menu, the input event that follows it) see the
    // current values rather than the ones from their render.
    const isOpenRef = useRef(false);
    const queryRef = useRef('');
    const querySourceRef = useRef<AddSourcesQuerySource>('editor');
    const triggerRef = useRef<OpenTrigger | null>(null);

    const updateQuery = useCallback((value: string) => {
        queryRef.current = value;
        setQueryValue(value);
    }, []);

    const open = useCallback((source: AddSourcesQuerySource, trigger: OpenTrigger | null, at: MenuPosition) => {
        triggerRef.current = trigger;
        querySourceRef.current = source;
        isOpenRef.current = true;
        updateQuery('');
        setQuerySourceValue(source);
        setPosition(at);
        setIsOpen(true);
    }, [updateQuery]);

    const close = useCallback(() => {
        triggerRef.current = null;
        querySourceRef.current = 'editor';
        isOpenRef.current = false;
        updateQuery('');
        setQuerySourceValue('editor');
        setIsOpen(false);
    }, [updateQuery]);

    /** Close and leave the typed text in the editor (Escape, outside click, …). */
    const dismiss = useCallback((reason?: SearchMenuCloseReason) => {
        const hadOwnSearchField = querySourceRef.current === 'menu';
        close();
        // That search field held DOM focus, so dismissing it would otherwise
        // leave the window with nothing focused. Hand focus back to the
        // composer — unless the user dismissed the menu by clicking elsewhere,
        // which is its own focus target.
        if (hadOwnSearchField && reason !== 'outside-click') {
            setTimeout(() => focusEditor(), 0);
        }
    }, [close, focusEditor]);

    /**
     * Close because something was picked: a typed `@query` did its job as a
     * search box, so it is removed rather than left in the message. A menu with
     * its own search field never put anything in the editor to take back.
     */
    const commit = useCallback(() => {
        // +1 for the `@` itself.
        const removeLength = querySourceRef.current === 'editor' ? queryRef.current.length + 1 : 0;
        close();
        if (removeLength > 0) deleteTrailingQuery(removeLength);
        // The click that picked the item may have taken DOM focus out of the
        // editor; restore it once the menu has actually unmounted.
        setTimeout(() => focusEditor(), 0);
    }, [close, deleteTrailingQuery, focusEditor]);

    /** Drop the typed query but keep the menu open (entering a submenu). */
    const resetQuery = useCallback(() => {
        const length = queryRef.current.length;
        const isEditorQuery = querySourceRef.current === 'editor';
        updateQuery('');
        if (isEditorQuery && length > 0) deleteTrailingQuery(length);
    }, [deleteTrailingQuery, updateQuery]);

    /** Open from the "+" button, with the menu's own search field. */
    const openFromButton = useCallback((at: MenuPosition) => {
        open('menu', null, at);
        // No focus handling here: `SearchMenu` focuses its search field as it
        // opens, and the composer is left exactly as the user left it.
    }, [open]);

    /** The menu's own search field, publishing what was typed into it. */
    const setQuery = useCallback((value: string) => {
        if (querySourceRef.current !== 'menu') return;
        updateQuery(value);
    }, [updateQuery]);

    /**
     * Detect a typed `@` trigger. Returns true when the menu opened.
     *
     * `editorRoot` is the editor's contenteditable. The menu clears the whole
     * composer vertically (it can be several lines tall), but is anchored
     * horizontally on the caret, so in a wide composer it opens at the `@` the
     * user just typed rather than at the far-away left edge. Falls back to that
     * edge when the caret has no measurable rect.
     */
    const handleTrigger = useCallback((value: string, editorRoot: HTMLElement): boolean => {
        const match = matchSourcesTrigger(value);
        if (!match) return false;
        const rect = editorRoot.getBoundingClientRect();
        const caretRect = getCaretRectWithin(editorRoot);
        const x = caretRect
            ? Math.min(Math.max(caretRect.left, rect.left), rect.right)
            : rect.left;
        const y = verticalPosition === 'above' ? rect.top - 5 : rect.bottom - 10;
        open('editor', { prefix: match.prefix }, { x, y });
        setMessageContent(value);
        return true;
    }, [open, setMessageContent, verticalPosition]);

    /** Handle an editor change while the menu is open. Returns true if handled. */
    const handleChange = useCallback((value: string): boolean => {
        // A menu with its own search field does not read the composer, so an
        // edit there is an ordinary edit.
        if (!isOpenRef.current || querySourceRef.current !== 'editor') return false;
        const trigger = triggerRef.current;
        const nextQuery = trigger ? queryForOpenTrigger(value, trigger) : null;
        if (nextQuery !== null) {
            updateQuery(nextQuery);
        } else {
            // The `@` was deleted, or the edit landed somewhere else entirely.
            close();
        }
        setMessageContent(value);
        return true;
    }, [close, setMessageContent, updateQuery]);

    /**
     * Handle a keydown in the editor while an editor-driven menu is open.
     * Returns true when the event was consumed. A menu with its own search
     * field takes its keystrokes there instead.
     *
     * Navigation keys are only preventDefault'ed (never stopPropagation'ed):
     * the event must keep bubbling to `SearchMenu`'s document-level listener,
     * which performs the actual navigation and selection.
     */
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>): boolean => {
        if (!isOpenRef.current || querySourceRef.current !== 'editor') return false;
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
        querySource,
        setQuery,
        openFromButton,
        handleTrigger,
        handleChange,
        handleKeyDown,
        dismiss,
        commit,
        resetQuery,
    };
}
