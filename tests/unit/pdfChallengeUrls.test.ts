import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    ChallengeUrlSkipped,
    isCaptchaChallengeUrl,
    refuseCaptchaChallengeUrls,
} from '../../react/utils/pdfChallengeUrls';

const CHALLENGE_URLS = [
    { match: '://www.sciencedirect.com', captchaLocator: '#captcha-box' },
    // On the challenge list, but handled entirely in a hidden browser.
    { match: '://pmc.ncbi.nlm.nih.gov', captchaLocator: null },
    { match: '://search.worldcat.org', captchaLocator: null },
];

/** Stand-in for the current `Zotero.BrowserRequest`. */
function currentApi() {
    return {
        CHALLENGE_URLS,
        getEntryForURL: (url: string) => CHALLENGE_URLS.find((e) => url.includes(e.match)) ?? null,
    };
}

/** Stand-in for the older `Zotero.BrowserDownload` shape. */
function legacyApi() {
    return {
        shouldAttemptDownloadViaBrowser: (url: string) =>
            CHALLENGE_URLS.find((e) => url.includes(e.match))?.match ?? false,
        getCaptchaLocator: (url: string) =>
            CHALLENGE_URLS.find((e) => url.includes(e.match))?.captchaLocator ?? null,
    };
}

beforeEach(() => {
    (globalThis as any).Zotero = {};
});

describe('isCaptchaChallengeUrl', () => {
    it('flags a host whose challenge entry can open a window', () => {
        (globalThis as any).Zotero.BrowserRequest = currentApi();

        expect(
            isCaptchaChallengeUrl('https://www.sciencedirect.com/science/article/pii/S1/pdf'),
        ).toBe(true);
    });

    it('leaves hidden-browser-only hosts alone', () => {
        (globalThis as any).Zotero.BrowserRequest = currentApi();

        expect(isCaptchaChallengeUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf/')).toBe(false);
        expect(isCaptchaChallengeUrl('https://search.worldcat.org/title/1')).toBe(false);
    });

    it('ignores ordinary hosts', () => {
        (globalThis as any).Zotero.BrowserRequest = currentApi();

        expect(isCaptchaChallengeUrl('https://arxiv.org/pdf/2301.00001')).toBe(false);
        expect(isCaptchaChallengeUrl('https://doi.org/10.1234/x')).toBe(false);
    });

    it('understands the older BrowserDownload shape', () => {
        (globalThis as any).Zotero.BrowserDownload = legacyApi();

        expect(isCaptchaChallengeUrl('https://www.sciencedirect.com/x/pdf')).toBe(true);
        expect(isCaptchaChallengeUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf/')).toBe(false);
        expect(isCaptchaChallengeUrl('https://arxiv.org/pdf/2301.00001')).toBe(false);
    });

    it('fetches normally on a build with neither API', () => {
        expect(isCaptchaChallengeUrl('https://www.sciencedirect.com/x/pdf')).toBe(false);
    });

    it('fetches normally when the lookup throws', () => {
        (globalThis as any).Zotero.BrowserRequest = {
            getEntryForURL: () => {
                throw new Error('unparseable URL');
            },
        };

        expect(isCaptchaChallengeUrl('not-a-url')).toBe(false);
    });
});

describe('refuseCaptchaChallengeUrls', () => {
    it('cancels a request that would open a window', () => {
        (globalThis as any).Zotero.BrowserRequest = currentApi();

        expect(() => refuseCaptchaChallengeUrls('https://www.sciencedirect.com/x/pdf')).toThrow(
            ChallengeUrlSkipped,
        );
    });

    it('lets every other request through', () => {
        (globalThis as any).Zotero.BrowserRequest = currentApi();

        expect(() => refuseCaptchaChallengeUrls('https://arxiv.org/pdf/2301.00001')).not.toThrow();
        expect(() =>
            refuseCaptchaChallengeUrls('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf/'),
        ).not.toThrow();
    });

    it('names the URL it refused, so a debug log explains the skip', () => {
        (globalThis as any).Zotero.BrowserRequest = currentApi();
        const url = 'https://www.sciencedirect.com/science/article/pii/S1/pdf';

        expect(() => refuseCaptchaChallengeUrls(url)).toThrow(url);
    });
});
