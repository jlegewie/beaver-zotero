/**
 * Registry of all help message definitions.
 * 
 * Each message is identified by a unique ID and includes:
 * - Display text and positioning
 * - Priority for queue ordering
 * - Whether it should only be shown once
 */

// =============================================================================
// Types
// =============================================================================

export interface HelpMessageDefinition {
    /** Unique identifier, used for persistence and targeting */
    id: string;
    /** Display text for the help message */
    message: string;
    /** Position relative to target element */
    position: 'top' | 'bottom';
    /** Priority for ordering (lower = higher priority) */
    priority: number;
    /** Only show this message once (default: true) */
    showOnce?: boolean;
}

// =============================================================================
// Message Registry
// =============================================================================

export const helpMessages: HelpMessageDefinition[] = [
    {
        id: 'edit-user-request',
        message: 'Click to edit your message and regenerate the response',
        position: 'top',
        priority: 10,
        showOnce: true,
    },
];

// =============================================================================
// Helper Functions
// =============================================================================

/** Get a message definition by ID */
export function getHelpMessage(id: string): HelpMessageDefinition | undefined {
    return helpMessages.find((m) => m.id === id);
}

/** Get all message IDs */
export function getHelpMessageIds(): string[] {
    return helpMessages.map((m) => m.id);
}

