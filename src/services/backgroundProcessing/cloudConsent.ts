import { getPref, setPref } from '../../utils/prefs';

export type CloudConsent = 'pending' | 'declined' | 'accepted';

/** Installation-local consent covers both cloud preparation features for one account. */
export function readCloudConsent(userId?: string): CloudConsent {
    if (!userId) return 'pending';
    try {
        const record = JSON.parse(getPref('cloudPreparationConsent') || '{}');
        return record.version === 1 && (record.accounts?.[userId] === 'accepted' || record.accounts?.[userId] === 'declined')
            ? record.accounts[userId] : 'pending';
    } catch { return 'pending'; }
}

export function writeCloudConsent(userId: string, accepted: boolean): void {
    let accounts: Record<string, CloudConsent> = {};
    try {
        const previous = JSON.parse(getPref('cloudPreparationConsent') || '{}');
        if (previous.version === 1 && previous.accounts && typeof previous.accounts === 'object') accounts = previous.accounts;
    } catch { /* A malformed record never authorizes processing. */ }
    accounts[userId] = accepted ? 'accepted' : 'declined';
    setPref('cloudPreparationConsent', JSON.stringify({ version: 1, accounts }));
}
