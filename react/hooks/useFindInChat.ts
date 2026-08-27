import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAtomValue } from 'jotai';
import { isLoadingThreadAtom, lastRunSummaryAtom, threadRunIdsAtom } from '@beaver/agent-core/run-state/atoms';
import { FIND_CURRENT_CLASS, FIND_HIT_ATTR, isFindQueryActive } from '@beaver/agent-ui/chat/findContext';
import { currentThreadIdAtom } from '../atoms/threads';
import {
    annotationPanelStateAtom,
    notePanelStateAtom,
    thinkingVisibilityAtom,
    toolExpandedAtom,
} from '../atoms/messageUIState';
import { getScrollAtoms, latchIntentFromDistance, markProgrammaticScroll } from '../utils/scrollPosition';
import { findFirstHitAtOrBelow, stepMatchIndex } from '../utils/findNavigation';

/**
 * How long typing has to pause before the query reaches the renderers.
 *
 * Every change re-runs the markdown pipeline for every message in the thread,
 * so the query the renderers see lags the one the input shows.
 */
const FIND_DEBOUNCE_MS = 200;

/** Every hit inside `container`, in document order. */
function collectHits(container: HTMLElement): HTMLElement[] {
    const hits: HTMLElement[] = [];
    container.querySelectorAll(`mark[${FIND_HIT_ATTR}]`).forEach((node) => {
        if (node) hits.push(node as HTMLElement);
    });
    return hits;
}

/** Take the current-hit class off everything inside `container` that still has it. */
function clearCurrentClass(container: HTMLElement): void {
    container.querySelectorAll(`.${FIND_CURRENT_CLASS}`).forEach((node) => {
        (node as Element | null)?.classList.remove(FIND_CURRENT_CLASS);
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
    /** The thread's scroll container — the element hits are collected from and scrolled within. */
    containerRef: RefObject<HTMLElement | null>;
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
export function useFindInChat({ containerRef, isWindow }: UseFindInChatOptions): FindInChatState {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [matchCount, setMatchCount] = useState(0);
    const [currentIndex, setCurrentIndex] = useState(-1);
    const [focusToken, setFocusToken] = useState(0);

    // The thread's own content triggers: another thread opened, a run added, a
    // run reaching a status where it starts rendering its answer. A streaming
    // run is shadowed with an empty query while it streams, so it produces its
    // hits in one go when it stops.
    //
    // The runs are watched by their ids rather than by their count: two threads
    // with the same number of runs would otherwise look unchanged, and the hit
    // list would be left describing the thread that was just closed. The last
    // run's summary carries its status, which the count of ids does not.
    // Loading a thread unmounts the container, so the flag that ends the load is
    // what says the hits can be read again.
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const runIds = useAtomValue(threadRunIdsAtom);
    const lastRunSummary = useAtomValue(lastRunSummaryAtom);
    const isLoadingThread = useAtomValue(isLoadingThreadAtom);
    // A collapsed section renders nothing, so expanding one brings hits into a
    // thread the list was collected before — and collapsing one takes hits out
    // from under it. These are the four toggles that gate rendered markdown.
    const toolExpansion = useAtomValue(toolExpandedAtom);
    const thinkingVisibility = useAtomValue(thinkingVisibilityAtom);
    const notePanelState = useAtomValue(notePanelStateAtom);
    const annotationPanelState = useAtomValue(annotationPanelStateAtom);

    const scrollAtoms = getScrollAtoms(isWindow);

    // The hits, in document order, and the one the reader is on. Kept in refs
    // rather than state: the navigation callbacks read them, and re-creating
    // those callbacks per match would re-render the bar on every step.
    const matchesRef = useRef<HTMLElement[]>([]);
    const currentElementRef = useRef<HTMLElement | null>(null);
    const currentIndexRef = useRef(-1);
    // The query the current hit list was collected for, so a rebuild can tell a
    // new search (land on a fresh hit) from the same search over changed content
    // (keep the reader where they are).
    const collectedQueryRef = useRef('');

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
        const container = containerRef.current;
        if (container) clearCurrentClass(container);
        const element = index >= 0 && hits[index]?.isConnected ? hits[index] : undefined;
        element?.classList.add(FIND_CURRENT_CLASS);
        currentElementRef.current = element ?? null;
    }, [containerRef]);

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
        const container = containerRef.current;
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
    }, [containerRef, scrollAtoms]);

    /** Forget the result set and take the highlight off the thread. */
    const clearMatches = useCallback(() => {
        setCurrentElement([], -1);
        matchesRef.current = [];
        currentIndexRef.current = -1;
        collectedQueryRef.current = '';
        setMatchCount(0);
        setCurrentIndex(-1);
    }, [setCurrentElement]);

    // Rebuild the hit list after any render that could have changed it: the
    // query reaching the renderers, a run added, a run finishing. An observer
    // over the whole thread would fire on every frame of a response for a list
    // that cannot change until it ends.
    useEffect(() => {
        const container = containerRef.current;
        if (!isOpen || !container) return;

        const hits = collectHits(container);
        matchesRef.current = hits;

        const isNewQuery = collectedQueryRef.current !== activeQuery;
        collectedQueryRef.current = activeQuery;

        let index: number;
        if (isNewQuery) {
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

        // Only a new search moves the view. A rebuild for the same query is
        // something the thread did, not something the reader asked for.
        if (isNewQuery && index >= 0) {
            scrollToMatch(hits[index]);
        }
    }, [
        isOpen,
        activeQuery,
        currentThreadId,
        runIds,
        lastRunSummary,
        isLoadingThread,
        toolExpansion,
        thinkingVisibility,
        notePanelState,
        annotationPanelState,
        containerRef,
        setCurrentElement,
        scrollToMatch,
    ]);

    // A surface that goes away leaves no highlight behind. Only the DOM is
    // touched here — the state it belonged to is going with the component.
    useEffect(() => () => {
        const container = containerRef.current;
        if (container) clearCurrentClass(container);
    }, [containerRef]);

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
        if (isOpen && runIds.length === 0) close();
    }, [isOpen, runIds, close]);

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
