const MASK = '[MASKED]';

/** A JSON-encoded API-key field inside a string value. */
const ENCODED_API_KEY_FIELD = /("[\w-]*api[_-]?key"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/** `api_key`, `user_api_key`, `openAiApiKey`, ... */
const isSecretField = (key: string): boolean =>
    key.toLowerCase().replace(/[_-]/g, '').endsWith('apikey');

/**
 * Copy of `value` with API keys masked, for data sent off-device (error reports).
 *
 * Masks secret-named fields at any depth, and key fields inside JSON-encoded
 * string values such as the `lastUsedModel` preference, which stores custom
 * models together with their keys. Returns the JSON round-trip of `value`,
 * i.e. exactly what a request body would carry.
 */
export function redactSecrets<T>(value: T): T {
    const json = JSON.stringify(value, (key, item) => {
        if (isSecretField(key) && item && typeof item !== 'boolean') return MASK;
        if (typeof item === 'string' && item.includes('"')) {
            return item.replace(ENCODED_API_KEY_FIELD, `$1"${MASK}"`);
        }
        return item;
    });
    return json === undefined ? value : JSON.parse(json);
}
