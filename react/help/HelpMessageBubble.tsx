/**
 * Floating help message bubble component.
 * 
 * Renders a dismissable help tip anchored to a target element.
 * Uses portal for proper z-index stacking over all UI elements.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useSetAtom, useAtomValue } from 'jotai';
import { CancelIcon } from '../components/icons/icons';
import IconButton from '../components/ui/IconButton';
import { getDocumentFromElement, getWindowFromElement } from '../utils/windowContext';
import { dismissHelpMessageAtom, helpMessageFadingOutAtom } from '../atoms/helpMessages';
import { HelpMessageDefinition } from './helpMessages';

interface HelpMessageBubbleProps {
    /** The message definition to display */
    message: HelpMessageDefinition;
    /** The target element to anchor to */
    targetElement: HTMLElement;
    /** Reference element for portal context (from provider) */
    containerRef: React.RefObject<HTMLElement>;
}

/**
 * Floating help message bubble that anchors to a target element.
 */
export const HelpMessageBubble: React.FC<HelpMessageBubbleProps> = ({
    message,
    targetElement,
    containerRef,
}) => {
    const bubbleRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [arrowPosition, setArrowPosition] = useState<string>('50%');
    
    const dismissMessage = useSetAtom(dismissHelpMessageAtom);
    const isFadingOut = useAtomValue(helpMessageFadingOutAtom);
    
    // Calculate position relative to target element
    const calculatePosition = useCallback(() => {
        if (!targetElement || !bubbleRef.current) return;
        
        const win = getWindowFromElement(targetElement);
        const targetRect = targetElement.getBoundingClientRect();
        const bubbleRect = bubbleRef.current.getBoundingClientRect();
        
        // Center horizontally on target
        const centerX = targetRect.left + (targetRect.width / 2);
        
        // Position above or below based on message.position
        let posY: number;
        if (message.position === 'top') {
            posY = targetRect.top - bubbleRect.height - 12;
        } else {
            posY = targetRect.bottom + 12;
        }
        
        // Adjust X to keep bubble in viewport
        let posX = centerX;
        const rightEdge = posX + (bubbleRect.width / 2);
        if (rightEdge > win.innerWidth - 8) {
            const adjustment = rightEdge - (win.innerWidth - 8);
            posX -= adjustment;
        }
        
        const leftEdge = posX - (bubbleRect.width / 2);
        if (leftEdge < 8) {
            const adjustment = 8 - leftEdge;
            posX += adjustment;
        }
        
        // Calculate arrow offset from center
        const arrowPos = `calc(50% + ${centerX - posX}px)`;
        
        setPosition({ x: posX, y: posY });
        setArrowPosition(arrowPos);
    }, [targetElement, message.position]);
    
    // Calculate position on mount and when target changes
    useEffect(() => {
        // Initial calculation with delay for DOM readiness
        const timer = setTimeout(calculatePosition, 10);
        
        const win = getWindowFromElement(targetElement);
        
        // Recalculate on resize
        const handleResize = () => calculatePosition();
        win.addEventListener('resize', handleResize);
        
        // Recalculate on scroll
        const handleScroll = () => calculatePosition();
        win.addEventListener('scroll', handleScroll, true);
        
        return () => {
            clearTimeout(timer);
            win.removeEventListener('resize', handleResize);
            win.removeEventListener('scroll', handleScroll, true);
        };
    }, [targetElement, calculatePosition]);
    
    // Handle escape key to dismiss
    useEffect(() => {
        const doc = getDocumentFromElement(targetElement);
        
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                dismissMessage(message.id);
            }
        };
        
        doc.addEventListener('keydown', handleKeyDown, true);
        return () => {
            doc.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [message.id, dismissMessage, targetElement]);
    
    // Focus the bubble for keyboard accessibility
    useEffect(() => {
        if (bubbleRef.current) {
            bubbleRef.current.focus();
        }
    }, []);
    
    const handleDismiss = useCallback(() => {
        dismissMessage(message.id);
    }, [message.id, dismissMessage]);
    
    const bubbleElement = (
        <div
            ref={bubbleRef}
            className={`
                help-message-bubble
                ${isFadingOut ? 'help-message-bubble-fading-out' : ''}
                ${message.position === 'top' ? 'help-message-bubble-top' : 'help-message-bubble-bottom'}
            `}
            style={{
                position: 'fixed',
                top: position.y,
                left: position.x,
                transform: 'translateX(-50%)',
                zIndex: 10000,
            }}
            role="tooltip"
            tabIndex={-1}
            aria-label={message.message}
        >
            {/* Message content */}
            <div className="display-flex flex-row items-start gap-2 px-3 py-2">
                <span className="text-base font-color-primary flex-1">
                    {message.message}
                </span>
                <IconButton
                    variant="ghost-secondary"
                    icon={CancelIcon}
                    className="scale-90 -mr-1 -mt-025"
                    onClick={handleDismiss}
                    aria-label="Dismiss"
                />
            </div>
            
            {/* Arrow */}
            <span
                className={`help-message-arrow help-message-arrow-${message.position}`}
                style={{ left: arrowPosition }}
            />
        </div>
    );
    
    // Render via portal for proper z-index stacking
    const doc = getDocumentFromElement(containerRef.current || targetElement);
    const portalContainer = doc?.body;
    
    // Safety check: don't render if we don't have a valid container
    if (!portalContainer) {
        return null;
    }
    
    return ReactDOM.createPortal(bubbleElement, portalContainer);
};

export default HelpMessageBubble;

