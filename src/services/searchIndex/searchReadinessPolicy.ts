import type { SearchReadiness } from '@beaver/agent-core/protocol/agentProtocol';

export const SEARCH_READINESS_MAX_AGE_MS = 24 * 60 * 60_000;

export function unknownSearchReadiness(): SearchReadiness {
    return { policy_version: 1, ready: false, reason: 'unknown', discovery_complete: false,
        verified_at: null, index_version: null, extract_schema_versions: null,
        zotero_local_id: null, libraries: [] };
}

/** Hysteresis applies only to a previously ready, unchanged account/scope/version. */
export function evaluateSearchReadiness(
    observation: SearchReadiness,
    retainedReady: boolean,
    now = Date.now(),
): SearchReadiness {
    const result = { ...observation, ready: false };
    if (!observation.discovery_complete) return { ...result, reason: 'discovering' };
    const checked = observation.verified_at ? Date.parse(observation.verified_at) : NaN;
    if (!Number.isFinite(checked) || checked > now || now - checked >= SEARCH_READINESS_MAX_AGE_MS) {
        return { ...result, reason: 'stale' };
    }
    if (!observation.index_version || !observation.extract_schema_versions || !observation.zotero_local_id) {
        return { ...result, reason: 'unknown' };
    }
    if (!observation.libraries.some((library) => library.supported > 0)) return { ...result, reason: 'empty' };
    const threshold = retainedReady ? 90 : 95;
    const ready = observation.libraries.every(({ supported, confirmed }) =>
        Number.isInteger(supported) && Number.isInteger(confirmed)
        && supported >= 0 && confirmed >= 0 && confirmed <= supported
        && (supported === 0 || confirmed * 100 >= supported * threshold));
    return { ...result, ready, reason: ready ? 'ready' : 'coverage' };
}
