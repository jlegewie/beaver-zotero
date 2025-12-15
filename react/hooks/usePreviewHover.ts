import { useState, useRef, useEffect, useCallback, RefObject } from 'react';
import { useSetAtom, useAtom } from 'jotai';
import { activePreviewAtom, previewCloseTimeoutAtom, ActivePreview } from '../atoms/ui';
import { getWindowFromElement } from '../utils/windowContext';

// Define default delays, matching the original components
const DEFAULT_SHOW_DELAY = 100;
const DEFAULT_HIDE_DELAY = 350;

interface UsePreviewHoverOptions {
    showDelay?: number;
    hideDelay?: number;
    isEnabled?: boolean; // Option to disable the hover effect
    elementRef?: RefObject<HTMLElement | null>; // Optional element ref for correct window context
}

/**
 * Manages hover state and timers to display a preview using Jotai atoms.
 * @param previewContent The content to display in the preview when hovered.
 * @param options Configuration options for delays and enabling/disabling.
 * @returns Object containing event handlers, hover state, and a timer cancellation function.
 */
export function usePreviewHover(
    previewContent: ActivePreview | null, // Allow null to potentially disable preview dynamically
    options: UsePreviewHoverOptions = {}
) {
    const {
        showDelay = DEFAULT_SHOW_DELAY,
        hideDelay = DEFAULT_HIDE_DELAY,
        isEnabled = true,
        elementRef,
    } = options;

    // Helper to get window context from optional element ref
    const getWin = useCallback(() => {
        return getWindowFromElement(elementRef?.current ?? null);
    }, [elementRef]);

    const [isHovered, setIsHovered] = useState(false);
    const setActivePreview = useSetAtom(activePreviewAtom);
    const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
    const showPreviewTimerRef = useRef<number | null>(null);

    const cancelCloseTimer = useCallback(() => {
        if (previewCloseTimeout) {
            const win = getWin();
            win.clearTimeout(previewCloseTimeout);
            setPreviewCloseTimeout(null);
        }
    }, [previewCloseTimeout, setPreviewCloseTimeout, getWin]);

    const startCloseTimer = useCallback(() => {
        cancelCloseTimer();
        const win = getWin();
        const newTimeout = win.setTimeout(() => {
            setActivePreview(null);
            setPreviewCloseTimeout(null); // Clear the timeout ID itself
        }, hideDelay);
        setPreviewCloseTimeout(newTimeout);
    }, [cancelCloseTimer, hideDelay, setActivePreview, setPreviewCloseTimeout, getWin]);

    const cancelShowPreviewTimer = useCallback(() => {
        if (showPreviewTimerRef.current) {
            const win = getWin();
            win.clearTimeout(showPreviewTimerRef.current);
            showPreviewTimerRef.current = null;
        }
    }, [getWin]);

    const handleMouseEnter = useCallback(() => {
        setIsHovered(true);
        if (!isEnabled || !previewContent) return; // Check if enabled and content exists
        cancelCloseTimer();
        cancelShowPreviewTimer();

        const win = getWin();
        showPreviewTimerRef.current = win.setTimeout(() => {
            // Double-check isEnabled and previewContent in case they changed during the timeout
            if (isEnabled && previewContent) {
                setActivePreview(previewContent);
            }
            showPreviewTimerRef.current = null;
        }, showDelay);
    }, [isEnabled, previewContent, cancelCloseTimer, cancelShowPreviewTimer, setActivePreview, showDelay, getWin]);

    const handleMouseLeave = useCallback(() => {
        setIsHovered(false);
        if (!isEnabled) return;
        cancelShowPreviewTimer();
        startCloseTimer();
    }, [isEnabled, cancelShowPreviewTimer, startCloseTimer]);

    // Cleanup timers on unmount or when disabled
    useEffect(() => {
        return () => {
            cancelShowPreviewTimer();
            // No need to cancel close timer here, PreviewContainer handles its own logic
        };
    }, [cancelShowPreviewTimer]);

    // Function to manually cancel both timers, useful for cleanup before removal
    const cancelTimers = useCallback(() => {
        cancelShowPreviewTimer();
        cancelCloseTimer();
    }, [cancelShowPreviewTimer, cancelCloseTimer]);

    // Only return handlers if the hook is enabled
    const hoverEventHandlers = isEnabled
        ? { onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave }
        : {};

    return { hoverEventHandlers, isHovered, cancelTimers };
}