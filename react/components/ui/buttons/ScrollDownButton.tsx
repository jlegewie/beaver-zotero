import React from 'react';
import { Icon, ArrowDownIcon } from '../../icons/icons';
import { activeDialogAtom, hasPopupMessagesAtom } from '../../../atoms/ui';
import { getScrollAtoms } from '../../../utils/scrollPosition';
import { useAtomValue } from 'jotai';

interface ScrollDownButtonProps extends React.HTMLProps<HTMLButtonElement> {
    onClick: () => void;
    /** Whether this is rendered in the separate window (uses independent scroll state) */
    isWindow?: boolean;
}

/**
 * Offers a jump to the newest message while there is anything below the fold.
 *
 * Shown from the *measured* position rather than from whether the reader
 * scrolled back: the two part company whenever the distance changes without a
 * scroll event, which is most of a streaming response. Reading intent here left
 * the button hidden below content the reader could not see, and showing again
 * only once they happened to scroll.
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

    const isVisible = !isAtBottom && !hasPopupMessages && !activeDialog;

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
                        className={`scroll-down-button variant-ghost-secondary ${className || ''}`}
                        style={style}
                    >
                        <Icon icon={ArrowDownIcon} />
                    </button>
                </div>
            </div>
        </div>
    );
};
