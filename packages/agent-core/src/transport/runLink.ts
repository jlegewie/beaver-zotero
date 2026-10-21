/**
 * What a chat run owns apart from the socket that carries it.
 *
 * A backend that supports reattach keeps a run going for a grace period after
 * its socket is lost abnormally, so the client can open a new socket and pick
 * the run up (`WSReattachRequest`). Everything the client must remember across
 * that switch lives here rather than on the connection:
 *
 * - the reattach token and the highest run-event `seq` handled, so a replayed
 *   event is applied once;
 * - the reply to every backend request, by request id, so a request re-sent
 *   after a reattach is answered from memory instead of running again (an
 *   action must never be applied twice);
 * - the prompts already shown and the user's answers to them, so a re-sent
 *   prompt neither reappears nor goes unanswered;
 * - user decisions made while no socket can carry them, delivered once the
 *   reattach is confirmed.
 *
 * `AgentService` creates one per chat request and drops it when the run ends,
 * is closed on purpose, or cannot be reattached.
 */

import type { ConnectionFailureEvidence } from './connectionFailure';
import type { UndeliveredActionResult, WSCallbacks } from '../protocol/agentProtocol';
import { isPreparedJsonMessage, type PreparedJsonMessage } from './preparedJsonMessage';

/**
 * Close codes after which a backend that offers reattach keeps the run going:
 * no close frame (1006), no status (1005), a server error (1011) and the
 * heartbeat close (4000). A normal close (1000/1001) means the run is over.
 */
export const REATTACH_CLOSE_CODES: ReadonlySet<number> = new Set([1005, 1006, 1011, 4000]);

/** A reply to a backend request: the response, once the handler settles. */
export interface RunReply {
    response: Record<string, any> | PreparedJsonMessage | null;
    /** Resolves once `response` is set. */
    settled: Promise<void>;
    /** Connection the response was last written to, or null. */
    sentOn: number | null;
    /** Pings already written on `sentOn` when the response was. */
    pingMark: number;
    /** The agent action an `agent_action_execute` request applies. */
    actionId: string | null;
}

/** A prompt the server sent (approval, question, confirmation) and its answer. */
export interface RunPrompt {
    answer: Record<string, any> | null;
    /** Connection the answer was last written to, or null. */
    sentOn: number | null;
}

export class RunLink {
    readonly runId: string;
    /** The callbacks the run was started with; a reattach reuses them. */
    readonly callbacks: WSCallbacks;
    /** From `request_ack`; a run without one cannot be reattached. */
    token: string | null = null;
    /** Grace period the backend advertised in `ready`; null if it does not reattach runs. */
    graceMs: number | null = null;
    /** Highest run-event `seq` handled. */
    lastSeq = 0;
    /** A `done` or `error` has been handled: nothing is left to reattach for. */
    terminal = false;
    /** `reattaching` from a lost socket until the server confirms the reattach. */
    state: 'live' | 'reattaching' = 'live';
    /** The user stopped the run while it was reattaching; sent once reattached. */
    cancelRequested = false;
    /**
     * The stop is settled: the cancel was sent, or the server ended the run
     * itself. A stopped run dropped without either may still run on.
     */
    stopSettled = false;
    /** When the current loss was noticed. */
    detachedAt: number | null = null;
    /** `Date.now()` after which the client stops trying to reattach. */
    deadline: number | null = null;
    /** How the socket was lost. */
    dropEvidence: ConnectionFailureEvidence | null = null;
    deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    /** Resolves once the service stops carrying this run. */
    readonly ended: Promise<void>;
    private markEnded!: () => void;

    private readonly replies = new Map<string, RunReply>();
    private readonly prompts = new Map<string, RunPrompt>();
    private held: Record<string, any>[] = [];

    constructor(runId: string, callbacks: WSCallbacks) {
        this.runId = runId;
        this.callbacks = callbacks;
        this.ended = new Promise<void>((resolve) => { this.markEnded = resolve; });
    }

    /** The service no longer carries this run. */
    end(): void {
        this.clearDeadline();
        this.markEnded();
    }

    /** Whether the backend lets this run outlive its socket. */
    get reattachable(): boolean {
        return this.graceMs !== null;
    }

    // ------------------------------------------------------------------
    // Replies to backend requests
    // ------------------------------------------------------------------

    reply(requestId: string): RunReply | undefined {
        return this.replies.get(requestId);
    }

    /**
     * Start remembering the reply to `requestId`, which applies `actionId` if
     * it executes an action. Returns the entry and its settle function.
     */
    trackReply(
        requestId: string,
        actionId: string | null = null,
    ): { reply: RunReply; settle: (response: RunReply['response']) => void } {
        let resolve!: () => void;
        const settled = new Promise<void>((r) => { resolve = r; });
        const reply: RunReply = { response: null, settled, sentOn: null, pingMark: 0, actionId };
        this.replies.set(requestId, reply);
        return {
            reply,
            settle: (response) => {
                reply.response = response;
                resolve();
            },
        };
    }

    /** Whether any reply executes an action. */
    get hasActionReplies(): boolean {
        for (const reply of this.replies.values()) {
            if (reply.actionId) return true;
        }
        return false;
    }

    /**
     * The actions this run applied whose results the server is not known to
     * have read (see `forgetConfirmedReplies`). Waits for actions still
     * executing.
     */
    async unconfirmedAppliedActions(): Promise<UndeliveredActionResult[]> {
        const executes = [...this.replies.values()].filter((reply) => reply.actionId);
        await Promise.all(executes.map((reply) => reply.settled));
        const applied: UndeliveredActionResult[] = [];
        for (const reply of executes) {
            const response = reply.response;
            if (!response || isPreparedJsonMessage(response)) continue;
            if (response.type !== 'agent_action_execute_response' || response.success !== true) continue;
            applied.push({ actionId: reply.actionId!, resultData: response.result_data ?? {} });
        }
        return applied;
    }

    /**
     * Drop the payload of replies the server is known to have read: written on
     * `connectionId` before a ping whose pong has arrived. The server stops
     * re-sending a request once it reads the reply, but a re-send it wrote
     * earlier may still be waiting in the message queue, so the entry stays
     * as a marker that the request was answered and must not run again.
     */
    forgetConfirmedReplies(connectionId: number, pongsReceived: number): void {
        for (const reply of this.replies.values()) {
            if (reply.response !== null && reply.sentOn === connectionId && pongsReceived > reply.pingMark) {
                reply.response = null;
            }
        }
    }

    // ------------------------------------------------------------------
    // Prompts
    // ------------------------------------------------------------------

    /**
     * Record that a prompt arrived. Returns the earlier record when this id
     * was seen before (a re-send after a reattach), or null the first time.
     */
    notePrompt(key: string): RunPrompt | null {
        const existing = this.prompts.get(key);
        if (existing) return existing;
        this.prompts.set(key, { answer: null, sentOn: null });
        return null;
    }

    /** Whether the user answered the prompt `key` and the answer has not been written yet. */
    isAnswerUnsent(key: string): boolean {
        const prompt = this.prompts.get(key);
        return !!prompt?.answer && prompt.sentOn === null;
    }

    /** Remember the answer to a prompt and where it was written, if anywhere. */
    recordAnswer(key: string, answer: Record<string, any>, sentOn: number | null): void {
        this.prompts.set(key, { answer, sentOn });
    }

    // ------------------------------------------------------------------
    // Decisions made while reattaching
    // ------------------------------------------------------------------

    hold(message: Record<string, any>): void {
        this.held.push(message);
    }

    /** Whether a decision waits for the reattach. */
    get hasHeld(): boolean {
        return this.held.length > 0;
    }

    takeHeld(): Record<string, any>[] {
        const held = this.held;
        this.held = [];
        return held;
    }

    clearDeadline(): void {
        if (this.deadlineTimer !== null) {
            clearTimeout(this.deadlineTimer);
            this.deadlineTimer = null;
        }
    }
}

/**
 * The prompts a server sends and the decisions that answer them. Each pair is
 * correlated on one id field, which both messages carry.
 */
const PROMPTS = [
    { request: 'deferred_approval_request', response: 'deferred_approval_response', idField: 'action_id' },
    { request: 'credit_confirmation_request', response: 'credit_confirmation_response', idField: 'confirmation_id' },
    { request: 'batch_approval_request', response: 'batch_approval_response', idField: 'approval_id' },
    { request: 'ask_user_question_request', response: 'ask_user_question_response', idField: 'question_id' },
] as const;

function keyFor(prompt: (typeof PROMPTS)[number], message: Record<string, unknown>): string | null {
    const id = message[prompt.idField];
    return typeof id === 'string' && id.length > 0 ? `${prompt.request}:${id}` : null;
}

/** Key a prompt event shares with its answer, or null for any other event. */
export function promptKey(event: { event: string }): string | null {
    const prompt = PROMPTS.find((p) => p.request === event.event);
    return prompt ? keyFor(prompt, event as unknown as Record<string, unknown>) : null;
}

/** The prompt an outbound decision answers, or null for any other message. */
export function answeredPromptKey(message: Record<string, any>): string | null {
    const prompt = PROMPTS.find((p) => p.response === message.type);
    return prompt ? keyFor(prompt, message) : null;
}
