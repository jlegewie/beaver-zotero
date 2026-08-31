import { ApplicationStateInput } from "../protocol/agentProtocol";
import { Citation } from "../types/citations";
import { MessageAttachment } from "../types/attachments/apiTypes";
import { ZoteroLibrary, ZoteroCollection, ZoteroTag } from "../types/zotero";
import type { CardKind } from "../types/librarySuggestions";
import type { ActionCategory, ActionTargetType } from "../types/actions";

/**
 * LLM usage associated with an agent run.
 */
export interface RunUsage {
    requests: number;
    /** Number of requests made to the LLM API. */

    tool_calls: number;
    /** Number of successful tool calls executed during the run. */

    input_tokens: number;
    /** Total number of input/prompt tokens. */

    cache_write_tokens: number;
    /** Total number of tokens written to the cache. */

    cache_read_tokens: number;
    /** Total number of tokens read from the cache. */

    input_audio_tokens: number;
    /** Total number of audio input tokens. */

    cache_audio_read_tokens: number;
    /** Total number of audio tokens read from the cache. */

    output_tokens: number;
    /** Total number of output/completion tokens. */

    /**
     * Optional per-model-request usage entries in chronological order.
     * When present, this can be used to inspect latest-request usage
     * instead of relying only on aggregate totals.
     */
    model_requests?: ModelRequestUsage[];

    details?: Record<string, number>;
}

/**
 * Token usage for a single model request within a run.
 */
export interface ModelRequestUsage {
    input_tokens: number;
    output_tokens?: number;
    cache_write_tokens?: number;
    cache_read_tokens?: number;
    details?: Record<string, number>;
}

/** Tool request interface for agent runs */
export interface ToolRequest {
    function: "rag_search" | "search_external_references";
    /** The function to call (rag_search or search_external_references) */
    parameters: Record<string, any>;
    /** The parameters to pass to the function */
}

/** Search filters interface for agent runs */
export interface MessageSearchFilters {
    /** The libraries to search in */
    libraries: ZoteroLibrary[] | null;
    /** The collections to search in */
    collections: ZoteroCollection[] | null;
    /** The tags to search in */
    tags: ZoteroTag[] | null;
}

/**
 * Discriminated origin describing why a prompt was sent. Matches `PromptOrigin` in `app/models/agent_run.py`.
 *
 * `topic_label` and `collection_name` ride along on first-run origins so the
 * NextStepsPanel follow-up templates can reference the originating card's
 * topic / collection without re-fetching the suggestions response.
 */
export type PromptOrigin =
    | {
        kind: 'first_run_card';
        card_kind: CardKind;
        topic_label?: string | null;
        collection_name?: string | null;
        /** Set when this run was launched from an empty library. */
        empty_library?: boolean;
    }
    | {
        kind: 'first_run_followup';
        card_kind: CardKind;
        followup_id: string;
        topic_label?: string | null;
        collection_name?: string | null;
        empty_library?: boolean;
    }
    | {
        /**
         * Run launched from the "Where should we start?" first-action launcher.
         */
        kind: 'where_to_start';
        action_id: string;
        requires_topic?: boolean;
        topic_label?: string | null;
    };

/** True for any run launched from a first-run onboarding surface */
export function isFirstRunOrigin(origin: PromptOrigin | undefined | null): boolean {
    return (
        origin?.kind === 'first_run_card' ||
        origin?.kind === 'first_run_followup' ||
        origin?.kind === 'where_to_start'
    );
}

/**
 * A saved action the user invoked as a /command token in the message content.
 * Matches `PromptAction` in `app/models/agent_run.py`.
 *
 * The token stays verbatim in `BeaverAgentPrompt.content`; this object carries
 * the resolved prompt so the backend can tell the model what the command means.
 */
export interface PromptAction {
    /** Slash token as it appears in content, without the leading '/' */
    command: string;
    /** Client-side action id (builtin id or custom uuid) */
    action_id: string;
    /** Human-readable action title at send time */
    title?: string;
    /** Short human-facing description, shown in the /command chip hover card */
    description?: string;
    /** Resolved prompt text; null when the action definition no longer exists */
    prompt: string | null;
    /** Target-type group the action was invoked under */
    target_type?: ActionTargetType;
    /** Category the action belongs to */
    category?: ActionCategory;
}

/** Who initiated a resume request. */
export type ResumeTrigger = 'auto' | 'user';

/** Who initiated a retry request. */
export type RetryTrigger = 'auto' | 'user';

/**
 * Chat message content sent by the client.
 * Contains all user input for a chat completion request.
 */
export interface BeaverAgentPrompt {
    /** The message text content */
    content: string;
    /** Files, annotations, or sources attached to the message */
    attachments?: MessageAttachment[];
    /** Current application state (view, reader state, library selection) */
    application_state?: ApplicationStateInput;
    /** Search filters (libraries, collections, tags) */
    filters?: MessageSearchFilters;
    /** Explicit tool requests from the user (e.g., search_external_references) */
    tool_requests?: ToolRequest[];
    /** Whether this is a resume request */
    is_resume?: boolean;
    /** The run ID this request resumes (for resume requests) */
    resumes_run_id?: string;
    /** Who started the resume; only 'auto' reorders the backend model chain */
    resume_trigger?: ResumeTrigger;
    /** Custom system instructions for this request */
    custom_instructions?: string;
    /** Where this prompt came from */
    origin?: PromptOrigin;
    /** Saved actions invoked as /command tokens in `content` */
    actions?: PromptAction[];
}

// ============================================================================
// Model Message Parts
// ============================================================================

export interface UserPromptPart {
    part_kind: 'user-prompt';
    content: string;
}

/**
 * Outcome of a tool call, mirroring `ToolReturnPart.outcome`.
 *
 * - `success`: the tool returned a result payload.
 * - `failed`: the tool failed terminally; `content` is an error message.
 * - `denied`: the call was refused by an approval mechanism.
 * - `interrupted`: the run was cut off before the tool produced a result.
 *
 * Absent on older threads persisted before the field existed, so an absent
 * value must be read as `success` or handled by previous code paths.
 */
export type ToolReturnOutcome = 'success' | 'failed' | 'denied' | 'interrupted';

export interface ToolReturnPart {
    part_kind: 'tool-return';
    tool_name: string;
    content: any;
    tool_call_id: string;
    metadata?: Record<string, any>;
    outcome?: ToolReturnOutcome;
}

export interface RetryPromptPart{
    part_kind: 'retry-prompt';
    tool_name: string;
    content: any;
    tool_call_id: string;
}

/**
 * True when a tool return did not produce a usable result.
 *
 * Every non-success outcome carries an explanatory message as `content` instead
 * of a result payload, so none of them may reach the reference-extraction,
 * view-synthesis, or result-rendering paths that assume success-shaped content.
 * Treating the whole non-success set alike also keeps an outcome the backend
 * starts emitting later from silently rendering as a completed call.
 */
export function isUnsuccessfulToolReturn(
    part: ToolReturnPart | RetryPromptPart | null | undefined
): boolean {
    return (
        part?.part_kind === 'tool-return' &&
        part.outcome != null &&
        part.outcome !== 'success'
    );
}

/**
 * True when a successful write-tool return carries no result payload, because
 * the write turned out to be unnecessary.
 */
export function isEmptyWriteReturn(
    part: ToolReturnPart | RetryPromptPart | null | undefined
): boolean {
    if (part?.part_kind !== 'tool-return' || isUnsuccessfulToolReturn(part)) return false;
    if (typeof part.content === 'string') return true;
    return (
        part.tool_name === 'create_items' &&
        !!part.content &&
        typeof part.content === 'object' &&
        Object.keys(part.content.items_created ?? {}).length === 0
    );
}

export interface TextPart {
    part_kind: 'text';
    content: string;
}

export interface ThinkingPart {
    part_kind: 'thinking';
    content: string;
}

export interface ToolCallPart {
    part_kind: 'tool-call';
    tool_name: string;
    args: string | Record<string, any> | null;
    tool_call_id: string;
    tool_kind?: 'tool-search' | 'capability-load' | null;
    provider_details?: Record<string, any>;
    /** Optional progress message during tool execution (e.g., "Searching OpenAlex...") */
    progress?: string;
    /** Partially-parsed tool call arguments for live streaming preview (set by WSToolCallArgsStreamEvent) */
    streaming_args?: Record<string, any>;
}

// ============================================================================
// Agent Run Types
// ============================================================================

export type AgentRunStatus = 'in_progress' | 'completed' | 'error' | 'canceled' | 'awaiting_deferred';

/**
 * Whether a run is still live: streaming, or paused waiting on the user to
 * answer a deferred approval.
 *
 * A failed run stays in the active slot rather than moving to thread history —
 * a lost connection never delivers the terminal `done` event that archives it,
 * and the inline error card and its Retry button need the run to stay there.
 * So the presence of an active run does NOT mean the agent is still working;
 * anything asking "is Beaver still generating?" must go through this.
 */
export function isRunActive(run: { status: AgentRunStatus } | null | undefined): boolean {
    return run?.status === 'in_progress' || run?.status === 'awaiting_deferred';
}

interface AgentRunMetadata {
    citations: Citation[];
}

/**
 * Complete agent run from request to final output.
 * Stored in DB and used for rendering conversation history.
 */
export interface AgentRun {
    /** Client-generated agent run ID */
    id: string;
    user_id: string;
    /** The thread ID if the agent run is part of a thread (null for new threads until backend sends thread event) */
    thread_id: string | null;

    /** Agent type */
    agent_name: string;

    /** The user's message */
    user_prompt: BeaverAgentPrompt;

    /** Status */
    status: AgentRunStatus;
    /**
     * Error details when status is 'error', and the termination record the
     * backend writes on a run it stopped (status 'canceled').
     */
    error?: {
        type: string;
        message: string;
        /**
         * Why a 'canceled' run ended: the user's own stop ('client_cancel')
         * versus a run that was cut off ('client_closed', 'connection_lost',
         * 'server_shutdown'). See `isInterruptedRun`.
         */
        reason_code?: string;
        /** Client-generated, sanitized details that are safe to render to users. */
        user_facing_details?: string;
        /** Technical debugging information; never render directly. */
        details?: string;
        is_retryable?: boolean;
        retry_after?: number;
        is_resumable?: boolean;
        has_beaver_fallback?: boolean;
    };

    /** The model messages (built incrementally during streaming) */
    model_messages: ModelMessage[];

    /** Extracted/derived data */
    metadata?: AgentRunMetadata;

    /** Usage & cost */
    total_usage?: RunUsage;
    total_cost?: number;

    /** Model info */
    model_name: string;
    provider_name?: string;

    /** Timestamps */
    created_at: string;
    completed_at?: string;

    /** Data governance */
    consent_to_share: boolean;
}

export type ModelMessage = ModelRequest | ModelResponse;

export interface ModelRequest {
    kind: 'request';
    /* Message type identifier, this is available on all parts as a discriminator. */

    run_id: string;
    /* The unique identifier of the agent run in which this message originated. */

    parts: (UserPromptPart | ToolReturnPart | RetryPromptPart)[];
    /* The parts of the user message */

    instructions: string;
    /* The instructions for the model. Unused and should be empty. */

    metadata?: Record<string, any>;
    /* Metadata associated with the model request */
}

export interface ModelResponse {
    kind: 'response';
    /* Message type identifier */

    run_id: string;
    /* The unique identifier of the agent run in which this message originated. */

    model_name?: string;
    /* The name of the model used to generate this response. */

    provider_name?: string;
    /* The name of the provider used to generate this response. */

    finish_reason?: 'stop' | 'length' | 'content_filter' | 'tool_call' | 'error';
    /* Reason the model finished generating the response */

    parts: (TextPart | ThinkingPart | ToolCallPart)[];
    /* The parts of the model message */

    metadata?: Record<string, any>;
    /* Metadata associated with the model response */
}
