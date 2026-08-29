import React from 'react';
import { Icon, ArrowDownIcon } from '../../icons/icons';
import { activeDialogAtom, hasPopupMessagesAtom } from '../../../atoms/ui';
import { isWSChatPendingAtom } from '../../../atoms/agentRunAtoms';
import { getScrollAtoms } from '../../../utils/scrollPosition';
import { useAtomValue } from 'jotai';

/** How long the dots take to cross-fade out; keep in sync with `.scroll-down-icon`'s transition. */
const DOTS_FADE_MS = 200;

interface ScrollDownButtonProps extends React.HTMLProps<HTMLButtonElement> {
    onClick: () => void;
    /** Whether this is rendered in the separate window (uses independent scroll state) */
    isWindow?: boolean;
}

/**
 * Three dots on `MoreHorizontalIcon`'s baseline, drawn heavier and wider apart
 * than that icon so they read as a deliberate indicator at the arrow's size
 * rather than as an ellipsis. The bounce itself is CSS
 * (`.scroll-down-dots.is-bouncing`); at rest this renders as the steady
 * triplet, which is what the animation starts and ends on.
 */
const BouncingDotsIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} fill="currentColor" {...props}>
        <circle cx="3.5" cy="12.5" r="2.9" />
        <circle cx="12" cy="12.5" r="2.9" />
        <circle cx="20.5" cy="12.5" r="2.9" />
    </svg>
);

/**
 * Offers a jump to the newest message while there is anything below the fold.
 *
 * Shown from the *measured* position rather than from whether the reader
 * scrolled back: the two part company whenever the distance changes without a
 * scroll event, which is most of a streaming response. Reading intent here left
 * the button hidden below content the reader could not see, and showing again
 * only once they happened to scroll.
 *
 * While a run streams, the arrow gives way to bouncing dots — the button doubles
 * as the "still generating below" cue — and hovering brings the arrow back so
 * the affordance is never in doubt at the moment of clicking. Both icons stay
 * mounted and cross-fade in place; the bounce keeps running through the fade-out
 * so the dots never snap back to rest in view.
 *
 * Popup messages and dialogs still suppress it. They occupy the strip directly
 * above the composer that the button sits in, so this is about not colliding
 * with them, and it resolves on its own as soon as they clear.
 */
export const ScrollDownButton: React.FC<ScrollDownButtonProps> = ({
    onClick,
    className,
    style,
    isWindow = false,
}) => {
    const isAtBottom = useAtomValue(getScrollAtoms(isWindow).isAtBottom);
    const hasPopupMessages = useAtomValue(hasPopupMessagesAtom);
    const activeDialog = useAtomValue(activeDialogAtom);
    const isStreaming = useAtomValue(isWSChatPendingAtom);

    const isVisible = !isAtBottom && !hasPopupMessages && !activeDialog;

    // Outlasts `isStreaming` by the fade so the bounce covers its own exit.
    const [isBouncing, setIsBouncing] = React.useState(isStreaming);
    React.useEffect(() => {
        if (isStreaming) {
            setIsBouncing(true);
            return;
        }
        const timer = setTimeout(() => setIsBouncing(false), DOTS_FADE_MS);
        return () => clearTimeout(timer);
    }, [isStreaming]);

    return (
        <div className="relative w-full h-0">
            <div className={`
                transition-opacity duration-300
                ${isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}
            `}>
                <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10">
                    <button
                        onClick={onClick}
                        aria-label="Scroll to latest message"
                        aria-hidden={!isVisible}
                        tabIndex={isVisible ? 0 : -1}
                        className={`scroll-down-button variant-ghost-secondary ${isStreaming ? 'is-streaming' : ''} ${className || ''}`}
                        style={style}
                    >
                        <span className="scroll-down-icons">
                            <Icon icon={ArrowDownIcon} className="scroll-down-icon scroll-down-arrow" />
                            <Icon
                                icon={BouncingDotsIcon}
                                // Drawn larger than the arrow: three small dots need the extra
                                // area to stay legible, and nothing shifts since they share the
                                // arrow's grid cell.
                                size="1.5em"
                                className={`scroll-down-icon scroll-down-dots ${isBouncing ? 'is-bouncing' : ''}`}
                                aria-hidden={true}
                            />
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
};
