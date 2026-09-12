import { beforeEach, expect, it, vi } from 'vitest';
const prefs = vi.hoisted(() => ({ value: '' }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => prefs.value, setPref: (_key: string, value: string) => { prefs.value = value; } }));
import { readCloudConsent, writeCloudConsent } from '../../../src/services/backgroundProcessing/cloudConsent';
beforeEach(() => { prefs.value = ''; });
it('fails closed on a new installation, malformed records, and unknown versions', () => {
    expect(readCloudConsent('a')).toBe('pending');
    prefs.value = 'invalid';
    expect(readCloudConsent('a')).toBe('pending');
    prefs.value = JSON.stringify({ version: 2, accounts: { a: 'accepted' } });
    expect(readCloudConsent('a')).toBe('pending');
});
it('isolates accounts and remembers each decision across switches and feature grants', () => {
    writeCloudConsent('a', true);
    expect(readCloudConsent('b')).toBe('pending');
    writeCloudConsent('b', false);
    expect(readCloudConsent('b')).toBe('declined');
    expect(readCloudConsent('a')).toBe('accepted');
    expect(readCloudConsent()).toBe('pending');
    const installationOne = prefs.value;
    prefs.value = '';
    expect(readCloudConsent('a')).toBe('pending');
    prefs.value = installationOne;
    expect(readCloudConsent('a')).toBe('accepted');
});
