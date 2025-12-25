/**
 * Help message provider component.
 * 
 * Manages the display of help messages:
 * - Monitors registered help targets for visibility/eligibility
 * - Enforces rate limiting (one message per cooldown period)
 * - Renders the active help message bubble via portal
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
    helpTargetsAtom,
    activeHelpMessageIdAtom,
    helpMessageStateAtom,
    isInCooldownAtom,
    showHelpMessageAtom,
    HELP_MESSAGE_COOLDOWN_MS,
} from '../atoms/helpMessages';
import { getHelpMessage, helpMessages } from './helpMessages';
import HelpMessageBubble from './HelpMessageBubble';

interface HelpMessageProviderProps {
    children: React.ReactNode;
}

/**
 * Provider component that manages help message display.
 * Wrap your main content with this component to enable help messages.
 */
export const HelpMessageProvider: React.FC<HelpMessageProviderProps> = ({ children }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    
    const targets = useAtomValue(helpTargetsAtom);
    const activeMessageId = useAtomValue(activeHelpMessageIdAtom);
    const helpState = useAtomValue(helpMessageStateAtom);
    const isInCooldown = useAtomValue(isInCooldownAtom);
    const showMessage = useSetAtom(showHelpMessageAtom);
    
    // Find the best eligible message to show
    const findEligibleMessage = useCallback(() => {
        // Don't show if in cooldown or already showing a message
        if (isInCooldown || activeMessageId) return null;
        
        // Get all eligible targets
        const eligibleTargets: Array<{ id: string; priority: number }> = [];
        
        targets.forEach((target, id) => {
            // Skip if not visible or not enabled
            if (!target.isVisible || !target.enabled) return;
            
            // Skip if already dismissed (with safety check)
            if (helpState?.dismissed && id in helpState.dismissed) return;
            
            // Get the message definition
            const message = getHelpMessage(id);
            if (!message) return;
            
            eligibleTargets.push({ id, priority: message.priority });
        });
        
        // Sort by priority (lowest number = highest priority)
        eligibleTargets.sort((a, b) => a.priority - b.priority);
        
        // Return the highest priority eligible target
        return eligibleTargets.length > 0 ? eligibleTargets[0].id : null;
    }, [targets, helpState.dismissed, isInCooldown, activeMessageId]);
    
    // Check for eligible messages periodically
    useEffect(() => {
        // Initial check after a short delay (let components mount)
        const initialTimer = setTimeout(() => {
            const eligibleId = findEligibleMessage();
            if (eligibleId) {
                showMessage(eligibleId);
            }
        }, 1000);
        
        // Periodic check for new eligible messages
        const interval = setInterval(() => {
            const eligibleId = findEligibleMessage();
            if (eligibleId) {
                showMessage(eligibleId);
            }
        }, 2000); // Check every 2 seconds
        
        return () => {
            clearTimeout(initialTimer);
            clearInterval(interval);
        };
    }, [findEligibleMessage, showMessage]);
    
    // Also check when targets change
    useEffect(() => {
        const eligibleId = findEligibleMessage();
        if (eligibleId) {
            showMessage(eligibleId);
        }
    }, [targets, findEligibleMessage, showMessage]);
    
    // Get the active message and target element
    const activeMessage = activeMessageId ? getHelpMessage(activeMessageId) : null;
    const activeTarget = activeMessageId ? targets.get(activeMessageId) : null;
    
    // Only render bubble if we have all required elements
    const shouldShowBubble = activeMessage && 
        activeTarget && 
        activeTarget.element && 
        containerRef.current;
    
    return (
        <div ref={containerRef} className="help-message-provider">
            {children}
            
            {/* Render active help message bubble */}
            {shouldShowBubble && (
                <HelpMessageBubble
                    message={activeMessage}
                    targetElement={activeTarget.element}
                    containerRef={containerRef as React.RefObject<HTMLDivElement>}
                />
            )}
        </div>
    );
};

export default HelpMessageProvider;

