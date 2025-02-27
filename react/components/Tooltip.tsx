import React from 'react';
// @ts-ignore no idea why
import { useState, useRef, useEffect } from 'react';

// Gap between tooltip and window edge (in pixels)
const WINDOW_EDGE_GAP = 12;

interface TooltipProps {
    children: React.ReactNode;
    content: React.ReactNode;
    secondaryContent?: React.ReactNode; // Faded text that appears after the main content
    showArrow?: boolean;
    className?: string;
    disabled?: boolean;
    singleLine?: boolean; // Force tooltip text to be on one line
}

/**
* A tooltip component that displays content on hover
*/
const Tooltip: React.FC<TooltipProps> = ({
    children,
    content,
    secondaryContent,
    showArrow = false,
    className = '',
    disabled = false,
    singleLine = false
}) => {
    const [isVisible, setIsVisible] = useState<boolean>(false);
    const [position, setPosition] = useState({
        placement: 'bottom' as 'top' | 'bottom',
        tooltipStyle: {},
        arrowStyle: {}
    });
    const [isPositioned, setIsPositioned] = useState<boolean>(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    
    // Calculate position of tooltip
    const updatePosition = () => {
        if (!containerRef.current || !tooltipRef.current) return;
        
        const win = Zotero.getMainWindow();
        const containerRect = containerRef.current.getBoundingClientRect();
        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        const windowHeight = win.innerHeight;
        const windowWidth = win.innerWidth;
        
        // Check if tooltip would be off-screen at the bottom
        const wouldOverflowBottom = containerRect.bottom + tooltipRect.height + 10 > windowHeight - WINDOW_EDGE_GAP;
        const placement = wouldOverflowBottom ? 'top' : 'bottom';
        
        // Calculate the center point of the container
        const containerCenter = containerRect.left + (containerRect.width / 2);
        
        // Calculate ideal tooltip position (centered on container)
        let tooltipLeft = containerCenter - (tooltipRect.width / 2);
        
        // Calculate how far the tooltip would extend beyond the right edge
        const rightOverflow = tooltipLeft + tooltipRect.width - (windowWidth - WINDOW_EDGE_GAP);
        // Calculate how far the tooltip would extend beyond the left edge
        const leftOverflow = WINDOW_EDGE_GAP - tooltipLeft;
        
        // Adjust tooltip position if it overflows
        if (rightOverflow > 0) {
            // Shift left to avoid right overflow
            tooltipLeft -= rightOverflow;
        } else if (leftOverflow > 0) {
            // Shift right to avoid left overflow
            tooltipLeft += leftOverflow;
        }
        
        // Calculate arrow position (should point to container center)
        // Arrow position is relative to the tooltip
        const arrowLeft = containerCenter - tooltipLeft;

        // Prepare styles
        const tooltipStyle: any = {
            position: 'absolute',
            left: 0,
            transform: `translateX(${tooltipLeft}px)`,
            [placement === 'bottom' ? 'top' : 'bottom']: '100%',
            marginTop: placement === 'bottom' ? '10px' : undefined,
            marginBottom: placement === 'top' ? '10px' : undefined,
            opacity: 1,
            zIndex: 9999
        };
        
        const arrowStyle = {
            left: `${arrowLeft}px`,
        };
        
        // Set the position state
        setPosition({
            placement,
            tooltipStyle,
            arrowStyle
        });
        
        // Mark as positioned
        setIsPositioned(true);
    };
    
    // Handle mouse events
    const handleMouseEnter = () => {
        if (disabled) return;
        setIsVisible(true);
        setIsPositioned(false); // Reset positioning when showing
    };
    
    const handleMouseLeave = () => {
        setIsVisible(false);
    };
    
    // Handle scroll and click events to hide tooltip
    useEffect(() => {
        const win = Zotero.getMainWindow();
        const handleScroll = () => {
            setIsVisible(false);
        };
        
        const handleClick = () => {
            setIsVisible(false);
        };
        
        if (isVisible) {
            win.addEventListener('scroll', handleScroll, true);
            win.addEventListener('click', handleClick);
        }
        
        return () => {
            win.removeEventListener('scroll', handleScroll, true);
            win.removeEventListener('click', handleClick);
        };
    }, [isVisible]);
    
    // Perform positioning after render
    useEffect(() => {
        if (isVisible && !isPositioned) {
            // Using a longer timeout to ensure all content is fully rendered and measured
            const timeoutId = setTimeout(updatePosition, 50);
            return () => clearTimeout(timeoutId);
        }
    }, [isVisible, isPositioned]);
    
    // Force repositioning when content or options change
    useEffect(() => {
        if (isVisible) {
            setIsPositioned(false);
        }
    }, [content, secondaryContent, singleLine]);
    
    return (
        <div 
            className="relative inline-flex"
            ref={containerRef}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            {children}
            
            {isVisible && (
                <div
                    ref={tooltipRef}
                    className={`tooltip-container tooltip-fade-in-${position.placement} ${singleLine ? 'whitespace-nowrap' : ''} ${className}`}
                    style={{
                        ...position.tooltipStyle,
                        opacity: isPositioned ? 1 : 0, // Hide until positioned
                    }}
                >
                    {showArrow && (
                        <div 
                            className={`tooltip-arrow tooltip-arrow-${position.placement}`}
                            style={position.arrowStyle}
                        />
                    )}
                    <span>{content}</span>
                    {secondaryContent && (
                        <span className="font-color-tertiary ml-1">{secondaryContent}</span>
                    )}
                </div>
            )}
        </div>
    );
};

export default Tooltip; 