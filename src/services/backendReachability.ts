/** Last confirmed successful request to Beaver's regular HTTPS API. */
let lastSuccess: { at: number; source: string } | null = null;

export function recordBackendHttpSuccess(
    source: string,
    at: number = Date.now(),
): void {
    lastSuccess = { at, source };
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
