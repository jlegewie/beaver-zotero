/**
 * User-facing titles for agent-run error types, as shown by the in-chat error
 * card.
 */
const RUN_ERROR_TITLE_BY_TYPE: Record<string, string> = {
    // Account & Auth
    profile_not_found: 'Account Error',
    auth_failed: 'Account Error',
    invalid_auth: 'Account Error',
    auth_timeout: 'Account Error',
    inactive_subscription: 'Subscription Required',

    // Model Availability
    invalid_model: 'Model Not Available',
    llm_invalid_model: 'Model Not Available',
    llm_model_access_denied: 'Model Not Available',
    llm_tool_use_not_supported: 'Model Not Supported',
    model_requires_api_key: 'API Key Required',

    // Usage & Billing
    usage_limit_exceeded: 'Limit Reached',
    usage_billing_limit: 'Limit Reached',
    llm_insufficient_credits: 'Limit Reached',
    llm_quota_exceeded: 'Limit Reached',
    llm_rate_limit: 'Rate Limit Exceeded',
    llm_tier_limit: 'Rate Limit Exceeded',

    // API Key Issues
    llm_auth_error: 'API Key Issue',
    llm_verification_required: 'API Key Issue',

    // AI Service Problems
    llm_service_unavailable: 'AI Service Problem',
    llm_timeout: 'AI Service Problem',
    llm_connection_error: 'AI Service Problem',
    llm_streaming_error: 'AI Service Problem',

    // Request & Content
    llm_context_window_exceeded: 'Context Limit Reached',
    llm_content_filtered: 'Content Blocked',
    invalid_request: 'Request Problem',
    custom_model_missing: 'Request Problem',
    custom_model_conflict: 'Request Problem',
    llm_data_policy_error: 'Request Problem',
    llm_encoding_error: 'Request Problem',

    // Connection
    connection_error: 'Connection Failed',

    // System Errors
    frontend_version_error: 'Update Required',
    internal_error: 'System Error',
    llm_unexpected_error: 'System Error',
    llm_internal_error: 'System Error',
    llm_auth_error_internal: 'System Error',
    llm_server_error: 'Server Error',
    llm_client_error: 'Client Error',
};

/**
 * Typed title for an agent-run error, matching the in-chat error card header.
 */
export function getRunErrorTitle(type: string | undefined): string {
    if (!type) return 'An error occurred';
    return RUN_ERROR_TITLE_BY_TYPE[type] || 'An error occurred';
}
