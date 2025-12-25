/**
 * Hook for registering a UI element as a help message target.
 * 
 * Components use this hook to register their element with the help system.
 * The hook handles:
 * - Ref management for the target element
 * - IntersectionObserver for visibility tracking
 * - Registering/unregistering with the provider
 */

import { useRef, useEffect, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import {
    registerHelpTargetAtom,
    unregisterHelpTargetAtom,
    updateHelpTargetAtom,
    helpMessageStateAtom,
} from '../atoms/helpMessages';

export interface UseHelpMessageTargetOptions {
    /**
     * Whether the help message should be eligible to show.
     * Typically based on component state (e.g., canEditNow && !isEditing)
     */
    enabled: boolean;
}

export interface UseHelpMessageTargetResult {
    /** Ref to attach to the target element */
    targetRef: React.RefObject<HTMLDivElement>;
}

/**
 * Register a UI element as a help message target.
 * 
 * @param messageId - The ID of the help message (from helpMessages.ts registry)
 * @param options - Configuration options
 * @returns Object with targetRef to attach to the element
 * 
 * @example
 * ```tsx
 * const { targetRef } = useHelpMessageTarget('edit-user-request', {
 *     enabled: canEditNow && !isEditing,
 * });
 * 
 * return <div ref={targetRef}>...</div>;
 * ```
 */
export function useHelpMessageTarget(
    messageId: string,
    options: UseHelpMessageTargetOptions
): UseHelpMessageTargetResult {
    const { enabled } = options;
    const targetRef = useRef<HTMLDivElement>(null);
    
    const registerTarget = useSetAtom(registerHelpTargetAtom);
    const unregisterTarget = useSetAtom(unregisterHelpTargetAtom);
    const updateTarget = useSetAtom(updateHelpTargetAtom);
    const helpState = useAtomValue(helpMessageStateAtom);
    
    // Check if already dismissed - don't register if so
    // Use optional chaining for safety in case dismissed is undefined
    const isDismissed = helpState?.dismissed ? messageId in helpState.dismissed : false;
    
    // Register on mount, unregister on unmount
    useEffect(() => {
        if (isDismissed) return;
        
        const element = targetRef.current;
        if (!element) return;
        
        // Initial registration
        registerTarget({
            id: messageId,
            element,
            isVisible: false,
            enabled,
        });
        
        return () => {
            unregisterTarget(messageId);
        };
    }, [messageId, registerTarget, unregisterTarget, isDismissed]);
    
    // Update enabled state when it changes
    useEffect(() => {
        if (isDismissed) return;
        
        updateTarget({ id: messageId, enabled });
    }, [messageId, enabled, updateTarget, isDismissed]);
    
    // Update element ref if it changes
    useEffect(() => {
        if (isDismissed) return;
        
        const element = targetRef.current;
        if (element) {
            updateTarget({ id: messageId, element });
        }
    }, [messageId, updateTarget, isDismissed]);
    
    // IntersectionObserver for visibility tracking
    useEffect(() => {
        if (isDismissed) return;
        
        const element = targetRef.current;
        if (!element) return;
        
        const observer = new IntersectionObserver(
            ([entry]) => {
                updateTarget({
                    id: messageId,
                    isVisible: entry.isIntersecting,
                });
            },
            {
                // Use the thread view as root if available, otherwise viewport
                root: element.closest('#beaver-thread-view') || null,
                threshold: 0.5, // At least 50% visible
            }
        );
        
        observer.observe(element);
        
        return () => {
            observer.disconnect();
        };
    }, [messageId, updateTarget, isDismissed]);
    
    return { targetRef };
}

export default useHelpMessageTarget;

