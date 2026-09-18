import type { SearchReadinessStatus } from '../../../src/services/searchIndex/instanceSearchReadiness';

/** Coverage describes preparation; agent tool availability is enabled separately. */
export function searchReadinessSentence(status?: SearchReadinessStatus): string {
    if (!status) return 'Checking search coverage…';
    const { current, lastConfirmed, error } = status;
    const messages: Record<typeof current.reason, string> = {
        unknown: 'Search coverage is not yet verified.',
        discovering: 'Checking the included libraries and their current files.',
        empty: 'No supported attachments in the included libraries.',
        coverage: 'Search preparation is below the required coverage.',
        ready: 'Search preparation meets the required coverage.',
        stale: 'Search coverage needs to be verified again.',
        unavailable: 'Cloud search preparation is unavailable for this account.',
    };
    let text = error ? `${error} ${messages[current.reason]}` : messages[current.reason];
    const known = current.discovery_complete && current.verified_at ? current : lastConfirmed;
    if (known) {
        const supported = known.libraries.reduce((sum, library) => sum + library.supported, 0);
        const confirmed = known.libraries.reduce((sum, library) => sum + library.confirmed, 0);
        text += ` ${error || known !== current ? 'Last confirmed: ' : ''}${confirmed.toLocaleString()} of ${supported.toLocaleString()} supported attachments verified.`;
        if (known.verified_at) text += ` Checked ${new Date(known.verified_at).toLocaleString()}.`;
    }
    return text;
}
