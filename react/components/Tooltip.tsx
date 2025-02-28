import React from 'react';
// @ts-ignore no idea why this is needed
import { useEffect, useRef, useState, ReactNode } from 'react';
import ReactDOM from 'react-dom';

/**
* Props for the Tooltip component
*/
export interface TooltipProps {
    /** The element that triggers the tooltip */
    children: ReactNode;
    /** Main text content of the tooltip */
    content: ReactNode;
    /** Secondary content displayed on the right side */
    secondaryContent?: ReactNode;
    /** Whether to show the arrow pointing to the anchor element */
    showArrow?: boolean;
    /** Whether to display all content on a single line */
    singleLine?: boolean;
    /** Additional CSS class names */
    classNames?: string;
    /** Whether the tooltip is disabled */
    disabled?: boolean;
    /** Whether to use a portal for rendering (prevents containment issues) */
    usePortal?: boolean;
}

/**
* A reusable tooltip component
*/
const Tooltip: React.FC<TooltipProps> = ({
    children,
    content,
    secondaryContent,
    showArrow = true,
    singleLine = false,
    classNames = '',
    disabled = false,
    usePortal = false,
}) => {
    const [isOpen, setIsOpen] = useState<boolean>(false);
    const [position, setPosition] = useState<{ x: number; y: number; placement: 'top' | 'bottom' }>({ 
        x: 0, 
        y: 0, 
        placement: 'bottom' 
    });
    const [arrowPosition, setArrowPosition] = useState<string>('50%');
    
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    
    // Calculate tooltip position
    const calculatePosition = () => {
        if (!anchorRef.current || !tooltipRef.current) return;
        
        const mainWindow = Zotero.getMainWindow();
        const anchorRect = anchorRef.current.getBoundingClientRect();
        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        
        // Calculate center position (default)
        const centerX = anchorRect.left + (anchorRect.width / 2);
        
        // Check if tooltip should be displayed below or above the anchor
        const spaceBelow = mainWindow.innerHeight - anchorRect.bottom;
        const spaceAbove = anchorRect.top;
        
        let placement: 'top' | 'bottom' = 'bottom';
        let posY = anchorRect.bottom + 10;
        
        // If not enough space below, place it above
        if (spaceBelow < tooltipRect.height + 12 && spaceAbove > tooltipRect.height + 12) {
            placement = 'top';
            posY = anchorRect.top - tooltipRect.height - 12;
        }
        
        // Base position is at the anchor's center
        let posX = centerX;
        
        // Adjust if tooltip would overflow right or left edge
        const rightEdge = posX + (tooltipRect.width / 2);
        if (rightEdge > mainWindow.innerWidth - 8) {
            // Shift left to avoid right overflow
            const adjustment = rightEdge - (mainWindow.innerWidth - 8);
            posX -= adjustment;
        }
        
        const leftEdge = posX - (tooltipRect.width / 2);
        if (leftEdge < 8) {
            // Shift right to avoid left overflow
            const adjustment = 8 - leftEdge;
            posX += adjustment;
        }
        
        // Calculate arrow position (relative to tooltip left edge)
        const arrowPos = `calc(50% + ${centerX - posX}px)`;
        
        setPosition({ x: posX, y: posY, placement });
        setArrowPosition(arrowPos);
    };
    
    // Update position when tooltip is shown
    useEffect(() => {
        if (!isOpen) return;
        
        // Initial position calculation with a slight delay to ensure
        // the tooltip has been rendered and can be measured
        const initialPositionTimer = setTimeout(() => {
            calculatePosition();
        }, 10);
        
        const mainWindow = Zotero.getMainWindow();
        
        // Handle window resize
        const handleResize = () => calculatePosition();
        mainWindow.addEventListener('resize', handleResize);
        
        // Handle scroll events to close the tooltip
        const handleScroll = () => setIsOpen(false);
        mainWindow.addEventListener('scroll', handleScroll, true);
        
        // Handle click events to close the tooltip
        const handleClick = () => setIsOpen(false);
        mainWindow.addEventListener('click', handleClick);
        
        return () => {
            clearTimeout(initialPositionTimer);
            mainWindow.removeEventListener('resize', handleResize);
            mainWindow.removeEventListener('scroll', handleScroll, true);
            mainWindow.removeEventListener('click', handleClick);
        };
    }, [isOpen]);
    
    // Handle mouse enter/leave for the anchor element
    const handleMouseEnter = () => {
        if (disabled) return;
        setIsOpen(true);
    };
    
    const handleMouseLeave = () => {
        // setIsOpen(false);
    };
    
    // Wrap children to add mouse event handlers
    const wrappedChildren = (
        <div 
            ref={anchorRef}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            style={{ display: 'inline-block' }}
        >
            {children}
        </div>
    );
    
    // Tooltip element
    const tooltipElement = isOpen && (
        <div
            ref={tooltipRef}
            className={`
                bg-quaternary rounded-md p-0 shadow-md fixed z-1000 border-quinary
                ${position.placement === 'bottom' ? 'tooltip-fade-in-bottom' : 'tooltip-fade-in-top'}
                ${classNames}
            `}
            style={{
                top: position.y,
                left: position.x,
                transform: 'translateX(-50%)'
            }}
            role="tooltip"
            aria-hidden={!isOpen}
        >
            <div className={`
                px-2 py-1
                ${singleLine ? 'flex items-center' : ''}
                ${singleLine ? 'single-line' : ''}
            `}>
                <div className={`text-base font-color-secondary ${singleLine ? 'single-line' : ''}`}>
                    {content}
                </div>
                {secondaryContent && (
                    <div className={`
                        text-sm font-color-tertiary
                        ${singleLine ? 'ml-3' : 'mt-1'}
                        ${singleLine ? 'single-line' : ''}
                    `}>
                        {secondaryContent}
                    </div>
                )}
            </div>
            
            {showArrow && (
                <div 
                    className={`tooltip-arrow tooltip-arrow-${position.placement}`}
                    style={{ left: arrowPosition }}
                />
            )}
        </div>
    );
    
    // Use portal if requested - this helps when the tooltip needs to 
    // break out of a container with overflow:hidden or similar
    if (usePortal && isOpen) {
        return (
            <>
            {wrappedChildren}
            {ReactDOM.createPortal(
                tooltipElement,
                Zotero.getMainWindow().document.body
            )}
            </>
        );
    }
    
    return (
        <>
        {wrappedChildren}
        {tooltipElement}
        </>
    );
};

export default Tooltip;