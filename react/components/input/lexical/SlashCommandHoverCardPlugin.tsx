import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useAtomValue } from 'jotai';
import { actionsAtom } from '../../../atoms/actions';
import { ChipPopupCard, type ChipPopupContent } from '../../agentRuns/requestChips/ChipPopup';
import { buildActionPopup } from '../../agentRuns/requestChips/actionPopup';

/** Delay before the card opens, so mousing across the input doesn't flash it. */
const HOVER_OPEN_DELAY_MS = 300;
/** Matches the request-chip popup width (POPUP_WIDTH in ChipPopup). */
const CARD_WIDTH = 260;

/**
 * Floating popup card anchored to a DOM element. The pill is a Lexical-managed
 * text node inside the contenteditable, so the shared Tooltip component (which
 * must wrap its anchor) can't be used; this measures the card after render and
 * positions it above the pill (below as fallback), clamped to the window.
 * `pointer-events: none` keeps the card from stealing clicks from the editor.
 *
 * Rendered inline (position: fixed) rather than through a portal: the sidebar
 * mounts in the main window's chrome document, where `document.body` is not an
 * HTML body, so `createPortal` has no valid target — the same reason Tooltip
 * defaults to usePortal=false.
 */
const FloatingPopupCard: React.FC<{ anchor: HTMLElement; popup: ChipPopupContent }> = ({ anchor, popup }) => {
    const cardRef = useRef<HTMLSpanElement | null>(null);
    const [layout, setLayout] = useState<{ x: number; y: number; placement: 'top' | 'bottom'; arrow: string } | null>(null);

    useLayoutEffect(() => {
        const card = cardRef.current;
        const win = anchor.ownerDocument.defaultView;
        if (!card || !win) return;
        const anchorRect = anchor.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const centerX = anchorRect.left + anchorRect.width / 2;

        // Prefer above the pill (the input sits at the bottom of the pane).
        let placement: 'top' | 'bottom' = 'top';
        let y = anchorRect.top - cardRect.height - 12;
        if (y < 8 && win.innerHeight - anchorRect.bottom > cardRect.height + 12) {
            placement = 'bottom';
            y = anchorRect.bottom + 10;
        }

        const half = cardRect.width / 2;
        const x = Math.min(Math.max(centerX, half + 8), Math.max(half + 8, win.innerWidth - half - 8));
        setLayout({ x, y, placement, arrow: `calc(50% + ${centerX - x}px)` });
    }, [anchor, popup]);

    return (
        <span
            ref={cardRef}
            role="tooltip"
            className={`bg-quaternary rounded-md shadow-md fixed z-100000 border-popup block ${
                layout ? (layout.placement === 'bottom' ? 'tooltip-fade-in-bottom' : 'tooltip-fade-in-top') : ''
            }`}
            style={{
                top: layout?.y ?? -9999,
                left: layout?.x ?? -9999,
                transform: 'translateX(-50%)',
                width: `${CARD_WIDTH}px`,
                pointerEvents: 'none',
                display: 'block',
            }}
        >
            <ChipPopupCard {...popup} />
            {layout && (
                <span
                    className={`tooltip-arrow tooltip-arrow-${layout.placement} block`}
                    style={{ left: layout.arrow, display: 'block' }}
                />
            )}
        </span>
    );
};

/**
 * Hover card for in-input /command pills: action title, the first part of the
 * action's prompt, and an "Click to edit in Preferences" hint (clicking the pill opens
 * the action there — see SlashCommandClickPlugin).
 *
 * The card content comes from the live action definition (looked up by the
 * pill's data-action-id), falling back to the pill's data-title snapshot when
 * the action no longer exists.
 */
export const SlashCommandHoverCardPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    const actions = useAtomValue(actionsAtom);
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const cancelPending = () => {
            if (openTimerRef.current) {
                clearTimeout(openTimerRef.current);
                openTimerRef.current = null;
            }
        };
        const onMouseOver = (e: MouseEvent) => {
            const pill = (e.target as Element | null)?.closest?.('.beaver-slash-command') as HTMLElement | null;
            if (!pill) return;
            cancelPending();
            openTimerRef.current = setTimeout(() => setAnchor(pill), HOVER_OPEN_DELAY_MS);
        };
        const onMouseOut = (e: MouseEvent) => {
            const pill = (e.target as Element | null)?.closest?.('.beaver-slash-command');
            if (!pill) return;
            // Ignore moves within the pill itself.
            if (e.relatedTarget && pill.contains(e.relatedTarget as Node)) return;
            cancelPending();
            setAnchor(null);
        };
        // Any press in the editor (caret placement, pill click) closes the card.
        const onMouseDown = () => {
            cancelPending();
            setAnchor(null);
        };

        return editor.registerRootListener((rootElement, prevRootElement) => {
            if (prevRootElement) {
                prevRootElement.removeEventListener('mouseover', onMouseOver);
                prevRootElement.removeEventListener('mouseout', onMouseOut);
                prevRootElement.removeEventListener('mousedown', onMouseDown);
            }
            if (rootElement) {
                rootElement.addEventListener('mouseover', onMouseOver);
                rootElement.addEventListener('mouseout', onMouseOut);
                rootElement.addEventListener('mousedown', onMouseDown);
            }
            cancelPending();
            setAnchor(null);
        });
    }, [editor]);

    // Close when the hovered pill is removed by an editor update, and on
    // scroll or typing (the anchor rect is stale after either).
    useEffect(() => {
        if (!anchor) return;
        const unregister = editor.registerUpdateListener(() => {
            if (!anchor.isConnected) setAnchor(null);
        });
        const win = anchor.ownerDocument.defaultView;
        const close = () => setAnchor(null);
        win?.addEventListener('scroll', close, true);
        win?.addEventListener('keydown', close, true);
        return () => {
            unregister();
            win?.removeEventListener('scroll', close, true);
            win?.removeEventListener('keydown', close, true);
        };
    }, [editor, anchor]);

    if (!anchor) return null;

    const actionId = anchor.getAttribute('data-action-id');
    const action = actionId ? actions.find((a) => a.id === actionId) : undefined;
    const popup = buildActionPopup(
        action
            ? { title: action.title, description: action.description, prompt: action.text, category: action.category }
            : { title: anchor.getAttribute('data-title'), command: anchor.getAttribute('data-command') },
    );

    return <FloatingPopupCard anchor={anchor} popup={popup} />;
};

export default SlashCommandHoverCardPlugin;
