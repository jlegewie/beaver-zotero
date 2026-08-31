/**
 * Dev-only HTTP handler for measuring PDF retrieval.
 *
 * `/beaver/test/pdf-retrieval` runs one full retrieval attempt end to end:
 * create a throwaway parent item from supplied metadata, walk an ordered list
 * of strategies until one attaches a PDF, report what happened and how long
 * each step took, then erase the item and its files again.
 *
 * The strategies mirror `schedulePdfFetchTask` in `react/utils/addItemActions.ts`
 * one for one (`importFromURL` with `contentType: 'application/pdf'`, then
 * `addAvailableFile`), so a measurement taken here is a measurement of the code
 * users run. `add_file_from_urls` is the same `Zotero.Attachments` entry point
 * that path is proposed to move to. What differs between variants is only the
 * strategy list the caller sends, which keeps variant definitions in the
 * harness instead of spread through the plugin.
 *
 * `/beaver/test/pdf-captcha-eligibility` answers, without any network traffic,
 * which of a set of URLs Zotero would route through its hidden-browser /
 * CAPTCHA path. It asks Zotero's own `BrowserDownload.shouldAttemptDownloadViaBrowser`
 * rather than a copy of its allowlist, so the answer stays correct when that
 * allowlist changes upstream.
 *
 * Handler exports are wired to paths in `useHttpEndpoints.ts` →
 * `registerEndpoints()`.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { refuseCaptchaChallengeUrls } from '../../utils/pdfChallengeUrls';

interface ItemSpec {
    item_type?: string;
    title?: string;
    creators?: string[];
    year?: number;
    doi?: string;
    url?: string;
    publication?: string;
}

interface StrategySpec {
    kind: 'import_from_url' | 'add_available_file' | 'add_file_from_urls';
    label: string;
    url?: string;
    resolvers?: Record<string, unknown>[];
    timeout_ms?: number;
    skip_challenge_urls?: boolean;
}

interface AttemptResult {
    label: string;
    kind: string;
    ok: boolean;
    ms: number;
    timed_out: boolean;
    error?: string;
    access_method?: string;
}

/** One URL the resolver cascade tried, in the order it tried them. */
interface AttemptedUrl {
    url: string;
    /** Milliseconds after the strategy started. */
    ms: number;
    skipped: boolean;
}

interface OpenedWindow {
    /** Location of the window when we first managed to read it. */
    href: string | null;
    /** Milliseconds after the plan started. */
    ms: number;
    closed: boolean;
}

/**
 * Watch for windows opening while a plan runs.
 *
 * Zotero's CAPTCHA path (`BrowserDownload.downloadPDFViaViewer`) opens a real
 * window, focuses it, and waits up to `downloadPDFViaBrowser.downloadTimeout`
 * (60 s by default) for a human. During an unattended agent batch nobody is
 * there, so the question "does a window actually open" has to be answered by
 * observation, not by reading the allowlist.
 *
 * Closing the window is also the mitigation under test: `downloadPDFViaViewer`
 * installs an `onCloseWindow` listener that rejects the download as soon as the
 * window goes away, so closing it unblocks the attempt instead of waiting out
 * the 60 s.
 *
 * Attribution is process-wide, not per-request — run window-watching plans one
 * at a time or a concurrent plan's window will be recorded against the wrong one.
 */
function watchWindows(startedAt: number, closeThem: boolean) {
    const opened: OpenedWindow[] = [];
    const listener = {
        onOpenWindow(xulWindow: any) {
            const record: OpenedWindow = { href: null, ms: Date.now() - startedAt, closed: false };
            opened.push(record);
            let domWindow: any;
            try {
                domWindow = xulWindow.docShell?.domWindow;
            } catch (e) {
                logger(`pdf-retrieval: could not reach opened window: ${e}`, 2);
                return;
            }
            if (!domWindow) return;
            const capture = () => {
                try {
                    record.href = domWindow.location?.href ?? null;
                } catch (e) {
                    // A window mid-navigation can refuse a location read.
                }
                if (closeThem) {
                    try {
                        domWindow.close();
                        record.closed = true;
                    } catch (e) {
                        logger(`pdf-retrieval: failed to close window: ${e}`, 1);
                    }
                }
            };
            // The window has no useful location until it has loaded.
            domWindow.addEventListener('load', capture, { once: true });
            // ...and if it never fires a load we still want it gone.
            domWindow.setTimeout?.(capture, 5000);
        },
        onCloseWindow() {},
        onWindowTitleChange() {},
    };
    Services.wm.addListener(listener);
    return {
        opened,
        stop() {
            try {
                Services.wm.removeListener(listener);
            } catch (e) {
                logger(`pdf-retrieval: failed to remove window listener: ${e}`, 1);
            }
        },
    };
}

const DEFAULT_STRATEGY_TIMEOUT_MS = 30_000;
const DEFAULT_PLAN_TIMEOUT_MS = 120_000;

/**
 * Bounds the wait only: the losing promise is NOT cancelled, so a strategy that
 * times out may still attach a PDF afterwards. That leak is part of what these
 * measurements are for.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}

async function pdfAttachments(item: Zotero.Item): Promise<Zotero.Item[]> {
    const ids = await item.getAttachments();
    if (!ids?.length) return [];
    const attachments = await Promise.all(ids.map((id) => Zotero.Items.getAsync(id)));
    return attachments.filter((a): a is Zotero.Item => !!a && !a.deleted && a.isPDFAttachment());
}

/** Create the parent item the strategies attach to. Mirrors `createItemManually`. */
async function createProbeItem(libraryID: number, spec: ItemSpec): Promise<Zotero.Item> {
    let itemType = spec.item_type || 'journalArticle';
    const typeID = Zotero.ItemTypes.getID(itemType);
    if (!typeID || !Zotero.ItemTypes.getName(typeID)) itemType = 'document';

    const item = new Zotero.Item(itemType as any);
    item.libraryID = libraryID;

    const setIfValid = (field: string, value?: string) => {
        if (value && Zotero.ItemFields.isValidForType(field, item.itemTypeID)) {
            item.setField(field, value);
        }
    };
    setIfValid('title', spec.title);
    setIfValid('date', spec.year ? String(spec.year) : undefined);
    setIfValid('url', spec.url);
    setIfValid('DOI', spec.doi);
    setIfValid('publicationTitle', spec.publication);

    if (spec.creators?.length) {
        item.setCreators(
            spec.creators
                .slice(0, 20)
                .map((name) => (Zotero.Utilities as any).cleanAuthor(name, 'author'))
        );
    }

    await item.saveTx({ skipSelect: true });
    return item;
}

/** Describe the attached file without keeping a handle on it — it is about to be erased. */
async function describeAttachment(attachment: Zotero.Item): Promise<Record<string, unknown>> {
    let byteSize: number | null = null;
    try {
        const path = await attachment.getFilePathAsync();
        if (path) byteSize = (await IOUtils.stat(path as string)).size ?? null;
    } catch (e) {
        logger(`pdf-retrieval: stat failed: ${e}`, 2);
    }
    return {
        key: attachment.key,
        // Which URL actually produced the file.
        source_url: attachment.getField('url') || null,
        content_type: attachment.attachmentContentType || null,
        filename: attachment.attachmentFilename || null,
        byte_size: byteSize,
        link_mode: Zotero.Attachments.linkModeToName(attachment.attachmentLinkMode),
    };
}

async function runStrategy(
    item: Zotero.Item,
    libraryID: number,
    strategy: StrategySpec,
    attemptedUrls: AttemptedUrl[]
): Promise<{ attachment: Zotero.Item | null; accessMethod?: string }> {
    const timeout = strategy.timeout_ms ?? DEFAULT_STRATEGY_TIMEOUT_MS;

    if (strategy.kind === 'import_from_url') {
        if (!strategy.url) throw new Error('import_from_url requires url');
        const attachment = await withTimeout(
            Zotero.Attachments.importFromURL({
                libraryID,
                url: strategy.url,
                parentItemID: item.id,
                title: 'Full Text PDF',
                contentType: 'application/pdf',
                saveOptions: { skipSelect: true },
            }),
            timeout,
            `Attach PDF from ${strategy.url}`
        );
        return { attachment: (attachment as Zotero.Item) || null };
    }

    if (strategy.kind === 'add_available_file') {
        const attachment = await withTimeout(
            (Zotero.Attachments as any).addAvailableFile(item),
            timeout,
            'Find PDF'
        );
        return { attachment: (attachment as Zotero.Item) || null };
    }

    if (strategy.kind === 'add_file_from_urls') {
        // Empty resolvers = Zotero's own cascade (same as production strategy 3).
        // skip_challenge_urls applies the same onBeforeRequest hook.
        // Recording every attempted URL is what makes the resolver-cap question
        // answerable from a single run: the winning URL's rank in our candidate
        // list says directly which caps would still have found it.
        const startedAt = Date.now();
        const onBeforeRequest = (url: string) => {
            const record: AttemptedUrl = { url, ms: Date.now() - startedAt, skipped: false };
            attemptedUrls.push(record);
            if (strategy.skip_challenge_urls) {
                try {
                    refuseCaptchaChallengeUrls(url);
                } catch (e) {
                    record.skipped = true;
                    throw e;
                }
            }
        };
        // Zotero's own doi/url/oa/custom resolvers are appended so this arm is
        // a superset of `addAvailableFile`, never a narrower substitute.
        const resolvers = [
            ...(strategy.resolvers ?? []),
            ...(Zotero.Attachments as any).getFileResolvers(item),
        ];
        let accessMethod: string | undefined;
        const attachment = await withTimeout(
            (Zotero.Attachments as any).addFileFromURLs(item, resolvers, {
                onAccessMethodStart: (method: string) => {
                    accessMethod = method;
                },
                onBeforeRequest,
            }),
            timeout,
            'addFileFromURLs'
        );
        return { attachment: (attachment as Zotero.Item) || null, accessMethod };
    }

    throw new Error(`unknown strategy kind: ${strategy.kind}`);
}

export async function handleTestPdfRetrievalHttpRequest(request: any) {
    const {
        library_id,
        item: itemSpec,
        strategies,
        plan_timeout_ms,
        label,
        keep_item,
        watch_windows,
        close_windows,
    } = request as {
        library_id?: number;
        item?: ItemSpec;
        strategies?: StrategySpec[];
        plan_timeout_ms?: number;
        label?: string;
        keep_item?: boolean;
        watch_windows?: boolean;
        close_windows?: boolean;
    };

    if (!itemSpec) return { ok: false, error: 'item is required' };
    if (!Array.isArray(strategies) || strategies.length === 0) {
        return { ok: false, error: 'strategies is required' };
    }

    const libraryID = typeof library_id === 'number' ? library_id : Zotero.Libraries.userLibraryID;
    const library = Zotero.Libraries.get(libraryID);
    if (!library || !(library as Zotero.Library).editable) {
        return { ok: false, error: `library ${libraryID} is not editable` };
    }

    const planDeadline = Date.now() + (plan_timeout_ms ?? DEFAULT_PLAN_TIMEOUT_MS);
    const startedAt = Date.now();
    const windowWatch = watch_windows ? watchWindows(startedAt, close_windows !== false) : null;
    const attempts: AttemptResult[] = [];
    const attemptedUrls: AttemptedUrl[] = [];
    let item: Zotero.Item | null = null;
    let attached: Zotero.Item | null = null;
    let winning: AttemptResult | null = null;
    let createMs = 0;
    let fatal: string | undefined;

    try {
        const createStart = Date.now();
        item = await createProbeItem(libraryID, itemSpec);
        createMs = Date.now() - createStart;

        for (const strategy of strategies) {
            if (attached) break;
            if (Date.now() >= planDeadline) {
                attempts.push({
                    label: strategy.label,
                    kind: strategy.kind,
                    ok: false,
                    ms: 0,
                    timed_out: true,
                    error: 'plan budget exhausted before this strategy started',
                });
                continue;
            }

            const start = Date.now();
            const attempt: AttemptResult = {
                label: strategy.label,
                kind: strategy.kind,
                ok: false,
                ms: 0,
                timed_out: false,
            };
            try {
                const { attachment, accessMethod } = await runStrategy(
                    item, libraryID, strategy, attemptedUrls
                );
                attempt.access_method = accessMethod;
                if (attachment) {
                    attached = attachment;
                    attempt.ok = true;
                }
            } catch (e: any) {
                const message: string = e?.message || String(e);
                attempt.error = message;
                attempt.timed_out = message.includes('timed out');
            }
            attempt.ms = Date.now() - start;
            attempts.push(attempt);
            if (attempt.ok) winning = attempt;
        }

        // A strategy can attach a PDF without returning it — a translator run
        // from a landing page saves out of band. Production re-checks for the
        // same reason, so a measurement that skipped this would under-report.
        if (!attached && item) {
            const found = await pdfAttachments(item);
            if (found.length) {
                attached = found[0];
                winning = {
                    label: 'out_of_band',
                    kind: 'recheck',
                    ok: true,
                    ms: 0,
                    timed_out: false,
                };
            }
        }
    } catch (e: any) {
        fatal = e?.message || String(e);
    } finally {
        windowWatch?.stop();
    }

    const attachmentInfo = attached ? await describeAttachment(attached) : null;

    // Erase before returning: the probe item is not the caller's data, and a
    // run of any size would otherwise leave hundreds of items and their
    // downloaded files behind. Erasing the parent erases child attachments
    // and their stored files.
    let cleanedUp = false;
    if (item && !keep_item) {
        try {
            await item.eraseTx();
            cleanedUp = true;
        } catch (e: any) {
            logger(`pdf-retrieval: cleanup failed for ${item.key}: ${e?.message || e}`, 1);
        }
    }

    return {
        ok: !fatal,
        error: fatal,
        label: label ?? null,
        library_id: libraryID,
        item_key: item?.key ?? null,
        attached: !!attached,
        winning_strategy: winning?.label ?? null,
        winning_access_method: winning?.access_method ?? null,
        attachment: attachmentInfo,
        attempts,
        attempted_urls: attemptedUrls,
        create_ms: createMs,
        total_ms: Date.now() - startedAt,
        cleaned_up: cleanedUp,
        windows_opened: windowWatch?.opened ?? null,
    };
}


/**
 * Which of these URLs would Zotero route through its hidden-browser / CAPTCHA
 * path? Pure lookup against Zotero's own allowlist — no requests are made.
 *
 * Two outcomes are worth distinguishing, and only Zotero's own table can tell
 * them apart. An entry with a `captchaLocator` can escalate to
 * `downloadPDFViaViewer`, which opens a real focused window and waits for a
 * human. An entry without one is handled entirely in a hidden browser: slower,
 * but invisible.
 *
 * Eligibility is necessary but not sufficient: the download must also fail with
 * a 403 or a non-PDF body, and (for the window case) the loaded page must
 * actually contain the CAPTCHA element. So this is an upper bound on exposure.
 *
 * `Zotero.BrowserRequest` is the current API; `Zotero.BrowserDownload` is the
 * older name. Neither is in the type definitions.
 */
export async function handleTestPdfCaptchaEligibilityHttpRequest(request: any) {
    const { urls } = request as { urls?: string[] };
    if (!Array.isArray(urls)) return { ok: false, error: 'urls is required' };

    const zot = Zotero as any;
    const api = zot.BrowserRequest ?? zot.BrowserDownload;
    if (!api) return { ok: false, error: 'no Zotero browser-request API found on this build' };

    const entryFor = (url: string) => {
        if (api.getEntryForURL) return api.getEntryForURL(url);
        const match = api.shouldAttemptDownloadViaBrowser?.(url);
        return match ? { match, captchaLocator: api.getCaptchaLocator?.(url) ?? null } : null;
    };

    const results = urls.map((url) => {
        try {
            const entry = entryFor(url);
            return {
                url,
                eligible: !!entry,
                matched_rule: entry?.match ?? null,
                captcha_selector: entry?.captchaLocator ?? null,
                // The distinction that matters for an unattended run.
                can_open_window: !!entry?.captchaLocator,
            };
        } catch (e: any) {
            return { url, eligible: false, matched_rule: null, error: e?.message || String(e) };
        }
    });

    return {
        ok: true,
        results,
        // Recorded so a harness run states the allowlist it was measured against.
        api: zot.BrowserRequest ? 'BrowserRequest' : 'BrowserDownload',
        challenge_urls: api.CHALLENGE_URLS ?? Object.keys(api.HANDLED_URLS ?? {}),
        // How long the viewer window waits for a human. Pref was renamed
        // alongside BrowserDownload -> BrowserRequest; read whichever exists.
        captcha_wait_ms:
            Zotero.Prefs.get('browserRequest.timeout')
            ?? Zotero.Prefs.get('downloadPDFViaBrowser.downloadTimeout')
            ?? null,
        zotero_version: Zotero.version,
    };
}
