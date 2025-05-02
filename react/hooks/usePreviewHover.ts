import { useState, useRef, useEffect, useCallback } from 'react';
import { useSetAtom, useAtom } from 'jotai';
import { activePreviewAtom, previewCloseTimeoutAtom, ActivePreview } from '../atoms/ui';

// Define default delays, matching the original components
const DEFAULT_SHOW_DELAY = 100;
const DEFAULT_HIDE_DELAY = 350;

interface UsePreviewHoverOptions {
    showDelay?: number;
    hideDelay?: number;
    isEnabled?: boolean; // Option to disable the hover effect
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
    } = options;

    const [isHovered, setIsHovered] = useState(false);
    const setActivePreview = useSetAtom(activePreviewAtom);
    const [previewCloseTimeout, setPreviewCloseTimeout] = useAtom(previewCloseTimeoutAtom);
    const showPreviewTimerRef = useRef<number | null>(null);

    const cancelCloseTimer = useCallback(() => {
        if (previewCloseTimeout) {
            Zotero.getMainWindow().clearTimeout(previewCloseTimeout);
            setPreviewCloseTimeout(null);
        }
    }, [previewCloseTimeout, setPreviewCloseTimeout]);

    const startCloseTimer = useCallback(() => {
        cancelCloseTimer();
        const newTimeout = Zotero.getMainWindow().setTimeout(() => {
            setActivePreview(null);
            setPreviewCloseTimeout(null); // Clear the timeout ID itself
        }, hideDelay);
        setPreviewCloseTimeout(newTimeout);
    }, [cancelCloseTimer, hideDelay, setActivePreview, setPreviewCloseTimeout]);

    const cancelShowPreviewTimer = useCallback(() => {
        if (showPreviewTimerRef.current) {
            Zotero.getMainWindow().clearTimeout(showPreviewTimerRef.current);
            showPreviewTimerRef.current = null;
        }
    }, []);

    const handleMouseEnter = useCallback(() => {
        if (!isEnabled || !previewContent) return; // Check if enabled and content exists

        setIsHovered(true);
        cancelCloseTimer();
        cancelShowPreviewTimer();

        showPreviewTimerRef.current = Zotero.getMainWindow().setTimeout(() => {
            // Double-check isEnabled and previewContent in case they changed during the timeout
            if (isEnabled && previewContent) {
                setActivePreview(previewContent);
            }
            showPreviewTimerRef.current = null;
        }, showDelay);
    }, [isEnabled, previewContent, cancelCloseTimer, cancelShowPreviewTimer, setActivePreview, showDelay]);

    const handleMouseLeave = useCallback(() => {
        if (!isEnabled) return;

        setIsHovered(false);
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