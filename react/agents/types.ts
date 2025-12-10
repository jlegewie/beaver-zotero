import { ApplicationStateInput } from "../../src/services/agentService";
import { CitationMetadata } from "../types/citations";
import { MessageAttachment } from "../types/attachments/apiTypes";
import { MessageSearchFilters, ToolRequest } from "src/services/chatService";

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

    details?: Record<string, number>;
}

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
}

// ============================================================================
// Model Message Parts
// ============================================================================

export interface UserPromptPart {
    part_kind: 'user-prompt';
    content: string;
}

export interface ToolReturnPart {
    part_kind: 'tool-return';
    tool_name: string;
    content: any;
    tool_call_id: string;
}

export interface RetryPromptPart{
    part_kind: 'retry-prompt';
    tool_name: string;
    content: any;
    tool_call_id: string;
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
}

// ============================================================================
// Agent Run Types
// ============================================================================

export type AgentRunStatus = 'in_progress' | 'completed' | 'error' | 'canceled' | 'awaiting_deferred';

interface AgentRunMetadata {
    citations: CitationMetadata[];
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
    error_message?: string;

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
}