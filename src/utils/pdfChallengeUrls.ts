/**
 * Keep Zotero's CAPTCHA window out of unattended PDF fetches.
 *
 * Some hosts answer an automated request with a bot challenge. Zotero then
 * opens a real window and waits for a human to solve it — fine for "Find Full
 * Text", wrong when an agent is adding items in the background.
 *
 * Refuse those URLs via `onBeforeRequest` (a throw skips the URL). Only
 * challenge-table entries with a `captchaLocator` can open a window; hosts
 * without one (PMC, WorldCat) stay in the hidden browser and are left alone.
 */

import { logger } from '@beaver/agent-core/platform/logger';

/** Thrown to cancel a request; `downloadFirstAvailableFile` skips the URL. */
export class ChallengeUrlSkipped extends Error {
    constructor(url: string) {
        super(`Skipped bot-challenge URL that would open a CAPTCHA window: ${url}`);
        this.name = 'ChallengeUrlSkipped';
    }
}

/**
 * Would Zotero open a CAPTCHA window for this URL if the download failed?
 *
 * Uses Zotero's own challenge table (`BrowserRequest`, or the older
 * `BrowserDownload`) so we track the current list. Returns false if neither
 * is present — an unknown build should fetch normally, not refuse every URL.
 */
export function isCaptchaChallengeUrl(url: string): boolean {
    const api = (Zotero as any).BrowserRequest ?? (Zotero as any).BrowserDownload;
    if (!api) return false;
    try {
        if (typeof api.getEntryForURL === 'function') {
            return !!api.getEntryForURL(url)?.captchaLocator;
        }
        // Older shape: a separate predicate and locator lookup.
        return !!(api.shouldAttemptDownloadViaBrowser?.(url) && api.getCaptchaLocator?.(url));
    } catch (e) {
        logger(`pdfChallengeUrls: could not classify ${url}: ${e}`, 2);
        return false;
    }
}

/**
 * `onBeforeRequest` hook for `addFileFromURLs`. Throws to skip URLs that
 * would open a CAPTCHA window, including ones from Zotero's own resolvers.
 */
export function refuseCaptchaChallengeUrls(url: string): void {
    if (isCaptchaChallengeUrl(url)) {
        logger(`pdfChallengeUrls: skipping ${url} — it would open a CAPTCHA window`, 2);
        throw new ChallengeUrlSkipped(url);
    }
}
