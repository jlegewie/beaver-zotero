/** Last confirmed successful request to Beaver's regular HTTPS API. */
let lastSuccess: { at: number; source: string } | null = null;

/**
 * Collapse dynamic path segments (ids, keys, cursors) to a placeholder so a
 * recorded source describes the route shape without carrying object
 * identifiers into diagnostic telemetry. Static route segments are lowercase
 * words (plus version tags like `v1`); anything else is treated as dynamic.
 */
export function normalizeEndpointForTelemetry(endpoint: string): string {
    const path = endpoint.split('?')[0];
    return path
        .split('/')
        .map((segment) =>
            segment === '' ||
            /^v\d+$/.test(segment) ||
            /^[a-z][a-z_-]*$/.test(segment)
                ? segment
                : ':id',
        )
        .join('/');
}

export function recordBackendHttpSuccess(
    source: string,
    at: number = Date.now(),
): void {
    // Normalize at the choke point: path-shaped sources are stripped of
    // dynamic identifiers no matter which caller recorded them.
    const normalized = source.startsWith('/')
        ? normalizeEndpointForTelemetry(source)
        : source;
    lastSuccess = { at, source: normalized };
}

export function getLastBackendHttpSuccess(): {
    at: number;
    source: string;
} | null {
    return lastSuccess ? { ...lastSuccess } : null;
}

/** Test/lifecycle helper. */
export function clearBackendHttpSuccess(): void {
    lastSuccess = null;
}
