import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { runsCountAtom } from '@beaver/agent-core/run-state/atoms';
import { FIND_CURRENT_CLASS, FIND_HIT_ATTR, isFindQueryActive } from '@beaver/agent-ui/chat/findContext';
import { currentThreadIdAtom } from '../atoms/threads';
import { getScrollAtoms, latchIntentFromDistance, markProgrammaticScroll } from '../utils/scrollPosition';
import { findFirstHitAtOrBelow, stepMatchIndex } from '../utils/findNavigation';

/**
 * How long typing has to pause before the query reaches the renderers.
 *
 * Every change re-runs the markdown pipeline for every message in the thread,
 * so the query the renderers see lags the one the input shows.
 */
const FIND_DEBOUNCE_MS = 200;

/** What a rendered find hit looks like in the document. */
const HIT_SELECTOR = `mark[${FIND_HIT_ATTR}]`;

/** Every hit inside `container`, in document order. */
function collectHits(container: HTMLElement): HTMLElement[] {
    const hits: HTMLElement[] = [];
    container.querySelectorAll<HTMLElement>(HIT_SELECTOR).forEach((hit) => hits.push(hit));
    return hits;
}

/** Whether any of `nodes` is a hit or contains one. */
function holdsHit(nodes: NodeList): boolean {
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        // Text nodes cannot be or contain an element.
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (element.matches(HIT_SELECTOR) || element.querySelector(HIT_SELECTOR)) return true;
    }
    return false;
}

/**
 * Whether a batch of mutations changed which hits the thread holds.
 *
 * The thread mutates constantly for reasons that have nothing to do with the
 * result set — a response streaming in, a tooltip mounting under the pointer —
 * and re-reading the whole thread for each of those would put a full-document
 * query on the hover path. A hit can only enter or leave by an element being
 * inserted or removed, so that is what is asked.
 */
function batchTouchesHits(records: MutationRecord[]): boolean {
    return records.some((record) => holdsHit(record.addedNodes) || holdsHit(record.removedNodes));
}

/** Take the current-hit class off everything inside `container` that still has it. */
function clearCurrentClass(container: HTMLElement): void {
    container.querySelectorAll(`.${FIND_CURRENT_CLASS}`).forEach((node) => {
        node.classList.remove(FIND_CURRENT_CLASS);
    });
}

/**
 * Opening the find bar, for the parts of the sidebar that are not the bar.
 *
 * Separate from the query context on purpose: the thread menu needs `open`, and
 * nothing else, so it must not re-render on every keystroke.
 */
export interface FindInChatControls {
    /** Open the bar, or refocus and select its input when it is already open. */
    open: () => void;
    /**
     * Whether a find session exists to open. False only where no provider is
     * above — the loading, login and onboarding pages, which render no chat.
     */
    isAvailable: boolean;
}

const NO_CONTROLS: FindInChatControls = Object.freeze({
    open: () => {},
    isAvailable: false,
});

const FindInChatControlsContext = createContext<FindInChatControls>(NO_CONTROLS);

/** Makes `controls` available to the sidebar subtree. Pair with `useFindInChatControls`. */
export const FindInChatControlsProvider = FindInChatControlsContext.Provider;

/**
 * How to open the find bar from elsewhere in the sidebar. Degrades to a no-op
 * with `isAvailable: false` when there is no provider above.
 */
export function useFindInChatControls(): FindInChatControls {
    return useContext(FindInChatControlsContext);
}

export interface UseFindInChatOptions {
    /**
     * The thread's scroll container — the element hits are collected from and
     * scrolled within. The element itself rather than a ref: the session has to
     * re-read the thread whenever the container is replaced, and a ref
     * assignment notifies nobody.
     */
    container: HTMLElement | null;
    /** Whether this surface is the separate Beaver window, which scrolls independently. */
    isWindow: boolean;
}

export interface FindInChatState {
    /** Whether the bar is showing. */
    isOpen: boolean;
    /** The raw query, as the input shows it. */
    query: string;
    /**
     * The query the renderers highlight on: debounced, and `''` whenever the bar
     * is closed so a closed bar leaves the thread exactly as it was.
     */
    activeQuery: string;
    /** Whether `activeQuery` is one that highlights, i.e. whether a count is meaningful. */
    isQueryActive: boolean;
    /** How many hits the thread currently holds. */
    matchCount: number;
    /** Zero-based index of the hit the reader is on, or -1 when there is none. */
    currentIndex: number;
    /** Bumped on every `open()`, including one while already open; the bar focuses on it. */
    focusToken: number;
    setQuery: (query: string) => void;
    next: () => void;
    previous: () => void;
    /** Open the bar, or refocus and select its input when it is already open. */
    open: () => void;
    close: () => void;
    /** The stable handle to pass to `FindInChatControlsProvider`. */
    controls: FindInChatControls;
}

/**
 * The find-in-chat session for one surface: the query, the hits, and where the
 * reader is among them.
 *
 * Deliberately component state rather than Jotai atoms. One store is shared by
 * the library sidebar, the reader sidebar and the separate Beaver window, so an
 * atom would put every surface on the same query and the same current match —
 * searching in the window would move the sidebar's view. Each surface calls this
 * hook and gets its own session.
 *
 * The hit list is read back out of the DOM rather than derived from the run
 * data: the renderers decide what a match is and where it lands, so the marks
 * they emitted are the only description of the result set that is guaranteed to
 * agree with what the reader can see.
 */
export function useFindInChat({ container, isWindow }: UseFindInChatOptions): FindInChatState {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [matchCount, setMatchCount] = useState(0);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [focusToken, setFocusToken] = useState(0);

    // Which thread is open decides what counts as a fresh search, and a thread
    // with no runs has no bar to keep open. Nothing else about the thread is
    // subscribed to here — what the DOM holds is observed rather than predicted
    // (see the rebuild effect below).
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const runsCount = useAtomValue(runsCountAtom);

    const scrollAtoms = getScrollAtoms(isWindow);

    // The hits, in document order, and the one the reader is on. Kept in refs
    // rather than state: the navigation callbacks read them, and re-creating
    // those callbacks per match would re-render the bar on every step.
    const matchesRef = useRef<HTMLElement[]>([]);
    const currentElementRef = useRef<HTMLElement | null>(null);
    const currentIndexRef = useRef(-1);
    // What the current hit list was collected for, so a rebuild can tell a new
    // search (land on a fresh hit) from the same search over changed content
    // (keep the reader where they are). The thread is part of it: the same query
    // in another thread is a different result set, and carrying the ordinal over
    // would put the reader on an unrelated match without moving the view to it.
    const collectedKeyRef = useRef<string | null>(null);

    // Closed means no highlighting at all, whatever is left in the input.
    const activeQuery = isOpen ? debouncedQuery : '';
    const isQueryActive = isFindQueryActive(activeQuery);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(query), FIND_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);

    /**
     * Move `FIND_CURRENT_CLASS` onto the hit at `index`.
     *
     * React owns the `<mark>` elements but not this class, so it is cleared from
     * the container rather than from the previous hit list: a re-render can
     * reuse an element that was current, and it would keep the class.
     */
    const setCurrentElement = useCallback((hits: HTMLElement[], index: number) => {
        if (container) clearCurrentClass(container);
        const element = index >= 0 && hits[index]?.isConnected ? hits[index] : undefined;
        element?.classList.add(FIND_CURRENT_CLASS);
        currentElementRef.current = element ?? null;
    }, [container]);

    /**
     * Bring a hit to roughly the middle of the container.
     *
     * Goes through the scroll seam instead of `scrollIntoView`: the thread's
     * auto-scroll cannot tell who moved the container, and an unannounced jump
     * backwards reads as the reader scrolling away from a response — which both
     * detaches auto-scroll and, on the way down, hands the reader back to the
     * bottom. `markProgrammaticScroll` claims the movement, and
     * `latchIntentFromDistance` records what landing here means for following.
     */
    const scrollToMatch = useCallback((element: HTMLElement) => {
        if (!container || container.clientHeight === 0) return;
        // A hit the thread has since re-rendered away measures as a zero rect,
        // which would scroll the container to an offset that means nothing.
        if (!element.isConnected) return;

        const elementTop = element.getBoundingClientRect().top
            - container.getBoundingClientRect().top
            + container.scrollTop;
        const centered = elementTop - (container.clientHeight - element.offsetHeight) / 2;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const scrollTop = Math.max(0, Math.min(centered, maxScrollTop));

        container.scrollTop = scrollTop;
        markProgrammaticScroll(container, 0, scrollTop);
        latchIntentFromDistance(container.scrollHeight - scrollTop - container.clientHeight, scrollAtoms);
    }, [container, scrollAtoms]);

    /** Forget the result set and take the highlight off the thread. */
    const clearMatches = useCallback(() => {
        setCurrentElement([], -1);
        matchesRef.current = [];
        currentIndexRef.current = -1;
        collectedKeyRef.current = null;
        setMatchCount(0);
        setCurrentIndex(-1);
    }, [setCurrentElement]);

    /**
     * Read the thread's hits and place the reader among them.
     *
     * The list is whatever the document holds now: a query change, a run
     * finishing, a collapsed section opened — every one of them ends as marks
     * appearing or disappearing, so the DOM is the one signal that covers them
     * all. Predicting them from state instead means enumerating every toggle
     * that gates rendered text, and missing the ones that are local to a
     * component.
     */
    const rebuild = useCallback(() => {
        if (!container) return;

        const hits = collectHits(container);
        matchesRef.current = hits;

        const collectedKey = `${currentThreadId ?? ''}\u0000${activeQuery}`;
        const isNewSearch = collectedKeyRef.current !== collectedKey;
        collectedKeyRef.current = collectedKey;

        let index: number;
        if (isNewSearch) {
            const containerTop = container.getBoundingClientRect().top;
            const offsets = hits.map(
                (hit) => hit.getBoundingClientRect().top - containerTop + container.scrollTop,
            );
            index = findFirstHitAtOrBelow(offsets, container.scrollTop);
        } else {
            // Same search, changed content: keep the reader on the hit they were
            // reading if it survived the re-render.
            const kept = currentElementRef.current ? hits.indexOf(currentElementRef.current) : -1;
            index = kept !== -1
                ? kept
                : Math.min(Math.max(currentIndexRef.current, hits.length ? 0 : -1), hits.length - 1);
        }

        currentIndexRef.current = index;
        setMatchCount(hits.length);
        setCurrentIndex(index);
        setCurrentElement(hits, index);

        // Only a new search moves the view. A rebuild for the same search is
        // something the thread did, not something the reader asked for.
        if (isNewSearch && index >= 0) {
            scrollToMatch(hits[index]);
        }
    }, [container, activeQuery, currentThreadId, setCurrentElement, scrollToMatch]);

    // Read the thread once, then again whenever a hit enters or leaves it.
    //
    // Every way that can happen — the query reaching the renderers, a run
    // finishing and being highlighted for the first time, a collapsed section
    // opened or closed — ends as a `<mark>` being inserted or removed, so the
    // document is asked instead of every piece of state that might have caused
    // one. `batchTouchesHits` is what keeps that cheap: a streaming run holds no
    // hits (it renders with an empty query), so its per-frame churn is filtered
    // out, and so is a tooltip mounting under the pointer.
    //
    // Only `childList` is observed. The current-hit class is an attribute this
    // hook writes itself, so observing attributes would have it answer its own
    // writes.
    useEffect(() => {
        if (!isOpen || !container) return;

        rebuild();

        const win = container.ownerDocument.defaultView;
        if (!win) return;

        const observer = new win.MutationObserver((records) => {
            if (batchTouchesHits(records)) rebuild();
        });
        observer.observe(container, { childList: true, subtree: true });
        // The observer belongs to the window that created it, which on macOS can
        // close while the app keeps running.
        return () => observer.disconnect();
    }, [isOpen, container, rebuild]);

    // A container that goes away leaves no highlight behind. Only the DOM is
    // touched here — the state it belonged to is replaced by the rebuild that
    // follows, or is going with the component.
    useEffect(() => () => {
        if (container) clearCurrentClass(container);
    }, [container]);

    const step = useCallback((delta: number) => {
        const hits = matchesRef.current;
        const index = stepMatchIndex(currentIndexRef.current, hits.length, delta);
        if (index < 0) return;
        currentIndexRef.current = index;
        setCurrentIndex(index);
        setCurrentElement(hits, index);
        scrollToMatch(hits[index]);
    }, [setCurrentElement, scrollToMatch]);

    const next = useCallback(() => step(1), [step]);
    const previous = useCallback(() => step(-1), [step]);

    const close = useCallback(() => {
        clearMatches();
        // The query itself survives, so reopening offers it again for editing.
        setIsOpen(false);
    }, [clearMatches]);

    // A thread with no runs renders no bar — "New chat" while the bar is open is
    // the usual way there. Ending the session there too stops it from coming
    // back, carrying the previous thread's query, the moment the first run of
    // the new thread appears.
    useEffect(() => {
        if (isOpen && runsCount === 0) close();
    }, [isOpen, runsCount, close]);

    const open = useCallback(() => {
        setIsOpen(true);
        setFocusToken((token) => token + 1);
    }, []);

    const controls = useMemo<FindInChatControls>(() => ({ open, isAvailable: true }), [open]);

    return {
        isOpen,
        query,
        activeQuery,
        isQueryActive,
        matchCount,
        currentIndex,
        focusToken,
        setQuery,
        next,
        previous,
        open,
        close,
        controls,
    };
}
