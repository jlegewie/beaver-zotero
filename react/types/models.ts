/**
 * Pure model types shared by the chat model selector and the backend clients
 * that fetch/verify models. Zero Jotai/preferences/store imports so it can be
 * used by client-agnostic code.
 */

import { ModelProvider, CustomChatModel } from '@beaver/agent-core/types/customChatModel';

export type ProviderType = ModelProvider;
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Access mode determines how the model is accessed
 * - app_key: Use the app's API key (included in plan, uses credits)
 * - byok: Use the user's own API key (bring your own key)
 * - custom: Custom model with user's own configuration
 */
export type AccessMode = "app_key" | "byok" | "custom";

export interface ModelPricing {
    input: number;
    output: number;
    cache_write?: number;
    cache_read?: number;
}

/**
 * ModelConfig interface representing an AI model for chat completion
 * Matches the backend ModelConfig model from model_configs table.
 */
export interface ModelConfig {
    /** UUID from backend model_configs table (or synthetic ID for custom models) */
    id: string;
    provider: ProviderType;
    name: string;
    /** The provider's model identifier used in API calls */
    snapshot: string;
    pricing?: ModelPricing;
    is_enabled?: boolean;

    // Access and billing configuration
    is_default: boolean;
    credit_cost: number;
    /** Whether users can use their own API key with this model */
    allow_byok: boolean;
    /** Whether this model is available via the app's API key */
    allow_app_key: boolean;

    // Model capabilities
    reasoning_model?: boolean;
    reasoning_effort?: ReasoningEffort;
    context_window?: number;
    supports_vision?: boolean;

    // Frontend-only fields for custom models
    is_custom?: boolean;
    custom_model?: CustomChatModel;

    // Frontend-only field to track selected access mode
    // Only set when user explicitly selects a model from UI
    access_mode?: AccessMode;
}
