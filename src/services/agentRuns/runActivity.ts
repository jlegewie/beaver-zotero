/**
 * Chats with a run going, as thread lists show them. Kept free of imports
 * beyond types, so renderers can read the shape without the registry.
 */

import type { AwaitingInput } from '../threads/awaitingInput';

/** The event windows subscribe to for `addon.agentRuns.listActivity()`. */
export const RUN_ACTIVITY_EVENT = 'agent-runs:activity';

/** A chat with a run going. */
export interface RunActivity {
    /** Null until the server names a new chat. */
    threadId: string | null;
    sessionId: string;
    /** Open cards by kind, in the shape of the backend's `awaiting_input`; null when none. */
    awaiting: AwaitingInput | null;
    /** When the session's current work started (ms since epoch). */
    startedAt: number;
}
