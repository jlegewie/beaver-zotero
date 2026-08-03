/**
 * Pure types and helpers for custom chat models. This module intentionally has
 * zero imports so it can be shared by non-UI code (wire protocol types, backend
 * clients) without pulling in preferences, the Jotai store, or React UI.
 */

export type ModelProvider = "anthropic" | "google" | "openai" | "mistralai" | "meta-llama" | "deepseek-ai" | "groq";

/**
 * Configuration for custom models.
 *
 * Either:
 * - provider="openrouter" to use OpenRouter's API, OR
 * - api_base with format to use a custom OpenAI/Anthropic-compatible endpoint
 *
 * When api_base is provided, provider defaults to "custom" for logging purposes.
 */
export interface CustomChatModel {
    provider?: string;  // defaults to "custom"
    api_base?: string;
    format?: 'openai' | 'anthropic';
    api_key: string;
    name: string;
    snapshot: string;
    context_window?: number;
    reasoning_effort?: 'low' | 'medium' | 'high';
    supports_vision?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

export const isCustomChatModel = (obj: unknown): obj is CustomChatModel => {
    if (!isObject(obj)) return false;

    const {
        provider,
        api_base,
        format,
        api_key,
        name,
        snapshot,
        context_window,
        reasoning_effort,
        supports_vision
    } = obj as Record<string, unknown>;

    // Required fields
    if (typeof api_key !== 'string' || api_key.trim().length === 0) return false;
    if (typeof name !== 'string' || name.trim().length === 0) return false;
    if (typeof snapshot !== 'string' || snapshot.trim().length === 0) return false;

    // Either provider is 'openrouter' or api_base must be provided
    const normalizedProvider = typeof provider === 'string' ? provider.toLowerCase() : 'custom';
    if (normalizedProvider === 'custom' && !api_base) return false;

    // Optional field validations
    if (provider !== undefined && typeof provider !== 'string') return false;
    if (api_base !== undefined && typeof api_base !== 'string') return false;
    if (format !== undefined && format !== 'openai' && format !== 'anthropic') return false;
    if (context_window !== undefined && typeof context_window !== 'number') return false;
    if (reasoning_effort !== undefined &&
        reasoning_effort !== 'low' &&
        reasoning_effort !== 'medium' &&
        reasoning_effort !== 'high') return false;
    if (supports_vision !== undefined && typeof supports_vision !== 'boolean') return false;

    return true;
};

/** Default endpoint used when a custom provider has no explicit endpoint. */
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

export interface ApiBaseValidationResult {
    valid: boolean;
    error?: string;
}

/** Returns true when the host is a private, loopback, or link-local address. */
const isPrivateOrReservedHost = (host: string): boolean => {
    // IPv6 loopback / link-local / unique-local
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
        return true;
    }
    // IPv4 dotted-quad ranges
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const a = parseInt(ipv4[1], 10);
        const b = parseInt(ipv4[2], 10);
        if (a === 10) return true;                        // 10.0.0.0/8
        if (a === 127) return true;                       // loopback
        if (a === 0) return true;                         // 0.0.0.0/8
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true;          // 192.168.0.0/16
        if (a === 169 && b === 254) return true;          // link-local / cloud metadata
    }
    return false;
};

/**
 * Mirror of the backend SSRF protection for custom endpoints. Beaver routes
 * every request through its own backend, so custom endpoints must be reachable
 * from the public internet over HTTPS. Localhost, private networks, and reserved
 * IP ranges are rejected. Keeping this check client-side gives users an immediate
 * error before a request is attempted.
 */
export const validateCustomProviderApiBase = (apiBase: string | undefined): ApiBaseValidationResult => {
    const value = (apiBase ?? '').trim();
    if (!value) {
        return { valid: false, error: 'An endpoint URL is required for custom providers.' };
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { valid: false, error: 'Enter a valid URL, for example https://api.example.com/v1.' };
    }
    if (url.protocol !== 'https:') {
        return { valid: false, error: 'The endpoint must use HTTPS. Plain HTTP endpoints are blocked.' };
    }
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === 'localhost.localdomain') {
        return { valid: false, error: 'The endpoint cannot point to localhost. It must be reachable from the public internet.' };
    }
    if (isPrivateOrReservedHost(host)) {
        return { valid: false, error: 'The endpoint cannot use a private, internal, or reserved IP address. It must be reachable from the public internet.' };
    }
    return { valid: true };
};
