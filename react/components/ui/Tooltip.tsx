import React, { useEffect, useRef, useState, ReactNode } from 'react';
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
    /** Padding */
    padding?: boolean;
    /** Whether to show the tooltip on hover */
    width?: string;
    /** Whether to parse HTML in the content (use with caution) */
    allowHtml?: boolean;
    /** Custom content to render instead of the default content */
    customContent?: ReactNode;
    /** Whether the tooltip should stay open when clicking the anchor element */
    stayOpenOnAnchorClick?: boolean;
    /** Optional preferred placement ('top' or 'bottom') */
    placement?: 'top' | 'bottom';
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
    padding = true,
    width,
    allowHtml = false,
    customContent,
    stayOpenOnAnchorClick = false,
    placement: preferredPlacement,
}) => {
    const [isOpen, setIsOpen] = useState<boolean>(false);
    const [position, setPosition] = useState<{ x: number; y: number; placement: 'top' | 'bottom' }>({ 
        x: 0, 
        y: 0, 
        placement: preferredPlacement || 'bottom'
    });
    const [arrowPosition, setArrowPosition] = useState<string>('50%');
    
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    const isPointerOverAnchor = useRef<boolean>(false);
    const isPointerOverTooltip = useRef<boolean>(false);
    
    // Add a ref to track if the click occurred on the anchor
    const anchorClicked = useRef<boolean>(false);
    
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
        
        let placement: 'top' | 'bottom' = preferredPlacement || 'bottom';
        let posY = anchorRect.bottom + 10;
        
        // If not enough space below, place it above
        if (
            (preferredPlacement && preferredPlacement === 'top') ||
            (spaceBelow < tooltipRect.height + 12 && spaceAbove > tooltipRect.height + 12)
        ) {
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
        
        // Handle scroll events to close the tooltip (but not while hovered)
        const handleScroll = () => {
            if (isPointerOverAnchor.current || isPointerOverTooltip.current) {
                return;
            }
            setIsOpen(false);
        };
        mainWindow.addEventListener('scroll', handleScroll, true);
        
        // Handle click events to close the tooltip
        const handleClick = (e: MouseEvent) => {
            // If click inside tooltip, don't close
            if (tooltipRef.current && tooltipRef.current.contains(e.target as Node)) {
                return;
            }
            // If stayOpenOnAnchorClick is true and the click was on the anchor, don't close
            if (stayOpenOnAnchorClick && anchorClicked.current) {
                anchorClicked.current = false;
                return;
            }
            setIsOpen(false);
        };
        mainWindow.addEventListener('click', handleClick);
        
        return () => {
            clearTimeout(initialPositionTimer);
            mainWindow.removeEventListener('resize', handleResize);
            mainWindow.removeEventListener('scroll', handleScroll, true);
            mainWindow.removeEventListener('click', handleClick);
        };
    }, [isOpen, stayOpenOnAnchorClick]);
    
    // Close tooltip when disabled prop changes to true
    useEffect(() => {
        if (disabled && isOpen) {
            setIsOpen(false);
        }
    }, [disabled]);
    
    // Handle mouse enter/leave for the anchor element
    const handleMouseEnter = () => {
        if (disabled) return;
        // Don't show tooltip if content is empty
        if (content === null || content === undefined || content === '') return;
        isPointerOverAnchor.current = true;
        setIsOpen(true);
    };

    const handleMouseLeave = (e: React.MouseEvent) => {
        isPointerOverAnchor.current = false;
        const next = e.relatedTarget as Node | null;
        if (next && tooltipRef.current && tooltipRef.current.contains(next)) {
            return;
        }
        setIsOpen(false);
    };

    // Add a click handler to mark when anchor is clicked
    const handleAnchorClick = () => {
        anchorClicked.current = true;
    };

    // Ensure tooltip stays visible when the anchor remains hovered across rerenders
    useEffect(() => {
        if (disabled) return;

        const anchorEl = anchorRef.current;
        if (!anchorEl) return;

        const isHovering = anchorEl.matches(':hover');
        isPointerOverAnchor.current = isHovering;

        if (
            isHovering &&
            content !== null &&
            content !== undefined &&
            content !== ''
        ) {
            setIsOpen(true);
        }
    }, [disabled, content]);

    const handleTooltipMouseEnter = () => {
        isPointerOverTooltip.current = true;
    };

    const handleTooltipMouseLeave = (e: React.MouseEvent) => {
        isPointerOverTooltip.current = false;
        const next = e.relatedTarget as Node | null;
        if (next && anchorRef.current && anchorRef.current.contains(next)) {
            return;
        }
        setIsOpen(false);
    };
    
    // Wrap children to add mouse event handlers
    const wrappedChildren = (
        <span 
            ref={anchorRef}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={handleAnchorClick}
            style={{ display: 'inline-block' }}
        >
            {children}
        </span>
    );
    
    // Render content with HTML support if enabled
    const renderContent = () => {
        if (typeof content === 'string' && allowHtml) {
            return <span dangerouslySetInnerHTML={{ __html: content }} />;
        }
        return content;
    };
    
    // Render secondary content with HTML support if enabled
    const renderSecondaryContent = () => {
        if (typeof secondaryContent === 'string' && allowHtml) {
            return <span dangerouslySetInnerHTML={{ __html: secondaryContent }} />;
        }
        return secondaryContent;
    };
    
    // Tooltip element
    const tooltipElement = isOpen && (
        <span
            ref={tooltipRef}
            className={`
                bg-quaternary rounded-md shadow-md fixed z-1000 border-popup block
                ${position.placement === 'bottom' ? 'tooltip-fade-in-bottom' : 'tooltip-fade-in-top'}
                ${classNames}
            `}
            style={{
                top: position.y,
                left: position.x,
                transform: 'translateX(-50%)',
                width: width,
                display: 'block'
            }}
            role="tooltip"
            aria-hidden={!isOpen}
            onMouseEnter={handleTooltipMouseEnter}
            onMouseLeave={handleTooltipMouseLeave}
        >
            <span className={`
                    ${padding && 'px-2 py-1'} block
                    ${singleLine ? 'display-flex items-center' : ''}
                    ${singleLine ? 'single-line' : ''}
                `}
                style={{ display: singleLine ? 'flex' : 'block' }}
            >
                {customContent ? (
                    customContent
                ) : (
                    <>
                        <span 
                            className={`text-base font-color-secondary overflow-hidden text-ellipsis ${singleLine ? 'single-line' : ''}`}
                            style={{ display: 'inline-block', verticalAlign: 'middle' }}
                        >
                            {renderContent()}
                        </span>
                        {secondaryContent && (
                            <span className={`
                                text-sm font-color-tertiary
                                ${singleLine ? 'ml-3' : 'mt-1'}
                                ${singleLine ? 'single-line' : ''}
                            `}
                            style={{ 
                                display: singleLine ? 'inline-block' : 'block',
                                verticalAlign: 'middle'
                            }}
                            >
                                {renderSecondaryContent()}
                            </span>
                        )}
                    </>
                )}
            </span>
            
            {showArrow && (
                <span 
                    className={`tooltip-arrow tooltip-arrow-${position.placement} block`}
                    style={{ left: arrowPosition, display: 'block' }}
                />
            )}
        </span>
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