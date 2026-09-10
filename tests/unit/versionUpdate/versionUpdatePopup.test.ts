/**
 * A release note as a popup message, and the visual it can carry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prefs: {} as Record<string, unknown> }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => mocks.prefs[key],
    setPref: vi.fn(),
}));

beforeEach(() => {
    mocks.prefs = {};
    (globalThis as any).Zotero = { isMac: true };
});
afterEach(() => {
    delete (globalThis as any).Zotero;
});

import { versionUpdatePopupMessage } from '../../../react/utils/versionUpdatePopup';
import { getVersionUpdateMessageConfig, type VersionUpdateMessageConfig } from '../../../react/constants/versionUpdateMessages';
import { getVersionShowcase } from '../../../react/constants/versionShowcases';

describe('versionUpdatePopupMessage', () => {
    it('carries every part of the note, including its showcase, and never expires', () => {
        const config: VersionUpdateMessageConfig = {
            version: '9.9.9',
            title: 'T',
            text: 't',
            subtitle: 's',
            footer: 'f',
            learnMoreUrl: 'https://example.test',
            learnMoreLabel: 'More',
            steps: [{ title: 'Step', showcase: 'quick-prompt' }],
            showcase: 'quick-prompt',
            primaryAction: { type: 'quick-prompt', label: 'Try now' },
        };
        expect(versionUpdatePopupMessage(config)).toEqual({
            type: 'version_update',
            version: '9.9.9',
            title: 'T',
            text: 't',
            subtitle: 's',
            footer: 'f',
            learnMoreUrl: 'https://example.test',
            learnMoreLabel: 'More',
            featureList: undefined,
            steps: config.steps,
            showcase: 'quick-prompt',
            primaryAction: config.primaryAction,
            expire: false,
        });
    });

    it('names the quick prompt chord for this machine wherever the copy asks for it', () => {
        const config: VersionUpdateMessageConfig = {
            version: '9.9.9',
            title: 'T',
            text: 'Press {{quickPromptShortcut}} to start.',
            steps: [{ title: 'S', description: 'Also {{quickPromptShortcut}}.' }],
        };
        expect(versionUpdatePopupMessage(config).text).toBe('Press ⌘⌥J to start.');
        expect(versionUpdatePopupMessage(config).steps?.[0].description).toBe('Also ⌘⌥J.');

        (globalThis as any).Zotero = { isMac: false };
        mocks.prefs = { keyboardShortcut: 'k' };
        expect(versionUpdatePopupMessage(config).text).toBe('Press Ctrl+Alt+K to start.');
    });
});

describe('the quick prompt release note', () => {
    it('floats in the corner the feature lives in, with its showcase', () => {
        const config = getVersionUpdateMessageConfig('0.25.0-beta.1');
        expect(config?.inPanel).toBe(false);
        expect(config?.showcase).toBe('quick-prompt');
        expect(getVersionShowcase(config?.showcase)).toEqual(expect.any(Function));
        expect(getVersionShowcase(undefined)).toBeUndefined();
    });
});
