/**
 * Warning atoms for managing transient, dismissable warnings.
 * 
 * Warnings are different from errors:
 * - They don't block the response
 * - They can be dismissed by the user
 * - They are not persisted in the DB
 */

import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';

// =============================================================================
// Types
// =============================================================================

/** Data for low_credits warning */
export interface LowCreditsWarningData {
    remaining_credits: number;
    limit: number;
    remaining_percentage: number;
}

/** Union of all warning data types */
export type WarningData = LowCreditsWarningData | Record<string, unknown>;

/** A warning associated with a run */
export interface RunWarning {
    /** Unique ID for this warning instance */
    id: string;
    /** The run this warning is associated with */
    run_id: string;
    /** Warning type identifier (e.g., 'low_credits') */
    type: string;
    /** User-friendly message from the backend */
    message: string;
    /** Additional data specific to the warning type */
    data?: WarningData;
    /** Timestamp when the warning was received */
    created_at: string;
}

// =============================================================================
// Atoms
// =============================================================================

/** All warnings for the current session (keyed by warning id) */
export const threadWarningsAtom = atom<RunWarning[]>([]);

/** Add a warning to the session */
export const addWarningAtom = atom(
    null,
    (_get, set, params: { run_id: string; type: string; message: string; data?: Record<string, unknown> }) => {
        const warning: RunWarning = {
            id: uuidv4(),
            run_id: params.run_id,
            type: params.type,
            message: params.message,
            data: params.data,
            created_at: new Date().toISOString(),
        };
        set(threadWarningsAtom, (prev) => [...prev, warning]);
    }
);

/** Dismiss (remove) a warning by its ID */
export const dismissWarningAtom = atom(
    null,
    (_get, set, warningId: string) => {
        set(threadWarningsAtom, (prev) => prev.filter((w) => w.id !== warningId));
    }
);

/** Clear all warnings (e.g., when starting a new thread) */
export const clearWarningsAtom = atom(
    null,
    (_get, set) => {
        set(threadWarningsAtom, []);
    }
);

/** Get warnings for a specific run */
export const warningsForRunAtom = atom((get) => {
    const warnings = get(threadWarningsAtom);
    return (runId: string) => warnings.filter((w) => w.run_id === runId);
});

