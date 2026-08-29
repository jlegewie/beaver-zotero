import React, { useEffect, useRef } from 'react';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { ArrowDownIcon, ArrowUpIcon, CancelIcon, SearchIcon } from '../icons/icons';

export interface FindBarProps {
    /** The raw query, as typed. */
    query: string;
    /** Whether the query is long enough to search on; below that no count is shown. */
    isQueryActive: boolean;
    /** How many hits the thread holds. */
    matchCount: number;
    /** Zero-based index of the current hit, or -1 when there is none. */
    currentIndex: number;
    /** Changes whenever the bar is (re)opened; focuses and selects the input. */
    focusToken: number;
    onQueryChange: (query: string) => void;
    onNext: () => void;
    onPrevious: () => void;
    onClose: () => void;
}

/**
 * The find-in-chat bar: a query, where the reader is in the results, and the
 * three controls that move through them.
 *
 * Rendered inline, absolutely positioned over the top of the thread area — never
 * through a portal. `createPortal` needs an HTML body, and a Zotero chrome
 * document has none; portalling there crashes the window. Being absolute also
 * keeps it out of the thread's layout, so opening it moves nothing.
 */
const FindBar: React.FC<FindBarProps> = ({
    query,
    isQueryActive,
    matchCount,
    currentIndex,
    focusToken,
    onQueryChange,
    onNext,
    onPrevious,
    onClose,
}) => {
    const barRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // Where focus was before the bar took it, so closing puts it back rather
    // than dropping it on the document.
    const previousFocusRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const doc = barRef.current?.ownerDocument;
        const win = doc?.defaultView;
        const active = doc?.activeElement;
        if (win && active instanceof win.HTMLElement && !barRef.current?.contains(active)) {
            previousFocusRef.current = active;
        }
        return () => {
            const previous = previousFocusRef.current;
            if (previous?.isConnected) previous.focus();
        };
    }, []);

    // Opening the bar while it is already open — a second ⌘F — reselects the
    // query instead of doing nothing, so it can be typed straight over.
    useEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.select();
    }, [focusToken]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
        }
    };

    const hasMatches = matchCount > 0;

    return (
        <div ref={barRef} className="beaver-find-bar" role="search" aria-label="Find in chat">
            <SearchIcon width={13} height={13} className="beaver-find-bar-icon" />
            <input
                ref={inputRef}
                type="text"
                className="beaver-find-bar-input"
                placeholder="Find in chat"
                aria-label="Find in chat"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={handleKeyDown}
            />
            {/* Fixed-width and tabular: the counts change as the reader types,
                and a bar that resizes under them looks broken. */}
            <div className="beaver-find-bar-count" aria-live="polite">
                {!isQueryActive ? '' : hasMatches ? `${currentIndex + 1}/${matchCount}` : 'No results'}
            </div>
            <IconButton
                icon={ArrowUpIcon}
                variant="ghost"
                onClick={onPrevious}
                disabled={!hasMatches}
                ariaLabel="Previous match"
                title="Previous match (Shift+Enter)"
            />
            <IconButton
                icon={ArrowDownIcon}
                variant="ghost"
                onClick={onNext}
                disabled={!hasMatches}
                ariaLabel="Next match"
                title="Next match (Enter)"
            />
            <IconButton
                icon={CancelIcon}
                variant="ghost"
                onClick={onClose}
                ariaLabel="Close find bar"
                title="Close (Esc)"
            />
        </div>
    );
};

export default FindBar;
