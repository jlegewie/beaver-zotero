import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { logger } from '@beaver/agent-core/platform/logger';
import { getHost } from '../host';
import ErrorBoundary from '../primitives/ErrorBoundary';
import Icon from '../icons/Icon';
import AlertIcon from '../icons/AlertIcon';
import ArrowDownIcon from '../icons/ArrowDownIcon';
import ArrowRightIcon from '../icons/ArrowRightIcon';
import CopyIcon from '../icons/CopyIcon';
import TickIcon from '../icons/TickIcon';

/** Where users write when something breaks. */
export const SUPPORT_EMAIL = 'contact@beaverapp.ai';

const COPIED_FEEDBACK_MS = 1500;

/** What support needs to find the failure: the ids and the error, one per line. */
function detailLines(error: Error, threadId?: string | null, runId?: string | null): string[] {
    const lines: string[] = [];
    if (threadId) lines.push(`Chat ID: ${threadId}`);
    if (runId) lines.push(`Message ID: ${runId}`);
    lines.push(`Error: ${errorText(error)}`);
    return lines;
}

/** The error as support reads it: its message, after its type unless that is the plain `Error`. */
function errorText(error: Error): string {
    const name = error.name && error.name !== 'Error' ? error.name : '';
    if (!error.message) return name || 'Error';
    return name ? `${name}: ${error.message}` : error.message;
}

/** A report's starting text: the details, then room for the user's own account. */
function reportBody(details: string[]): string {
    return [...details, '', 'What were you doing when this happened?', ''].join('\n');
}

/**
 * Write a caught render error to the host log (debug output) and the error
 * console, with the ids support needs to find the chat.
 */
function logRenderError(
    scope: string,
    error: Error,
    info: React.ErrorInfo | null,
    ids: { threadId?: string | null; runId?: string | null } = {},
): void {
    const details = {
        threadId: ids.threadId ?? null,
        runId: ids.runId ?? null,
        error: errorText(error),
        componentStack: info?.componentStack ?? null,
    };
    logger(`Render error in ${scope}: ${details.error}`, details, 1);
    console.error(`[Beaver] Render error in ${scope}`, details, error);
}

export interface RenderErrorNoticeProps {
    error: Error;
    /** What failed to show, in plain words. */
    summary: string;
    /** What still works or what to do next, so the reader can carry on. */
    detail?: string;
    threadId?: string | null;
    runId?: string | null;
    /** The client's way out (e.g. a "New chat" button), shown as the notice's primary action. */
    actions?: React.ReactNode;
    /**
     * Whether to offer the client's report form. Off for a surface that does
     * not render that form; the notice then offers the support email instead.
     */
    reportable?: boolean;
    /**
     * `card` sits in a list in place of the failed part (a message); `page`
     * fills a surface of its own, centred like an empty state.
     */
    layout?: 'card' | 'page';
    /** Classes for the notice's outer element (its margins in the surrounding layout). */
    className?: string;
}

/**
 * The friendly notice shown in place of something that failed to render: a
 * plain sentence, one way to report the problem, and the ids and error folded
 * away under "Details" for support.
 *
 * The report goes to the client's report form when it has one, which carries
 * the details and the app's state; otherwise to the support email, with the
 * details filled in.
 */
export const RenderErrorNotice: React.FC<RenderErrorNoticeProps> = ({
    error,
    summary,
    detail,
    threadId,
    runId,
    actions,
    reportable = true,
    layout = 'card',
    className = '',
}) => {
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const copiedTimer = useRef<{ win: Window; id: number } | null>(null);
    useEffect(() => () => {
        const timer = copiedTimer.current;
        if (timer) timer.win.clearTimeout(timer.id);
    }, []);
    const detailsId = useId();

    const details = detailLines(error, threadId, runId);
    const detailsText = details.join('\n');
    const host = getHost();
    const reportRenderError = reportable ? host.dialogs?.reportRenderError : undefined;
    const openExternalUrl = host.navigation?.openExternalUrl;

    const handleReport = useCallback(() => {
        if (reportRenderError) {
            reportRenderError(`${summary}\n${reportBody(details)}`);
            return;
        }
        openExternalUrl?.(
            `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Beaver error report')}`
            + `&body=${encodeURIComponent(reportBody(details))}`,
        );
    }, [reportRenderError, openExternalUrl, summary, detailsText]);

    const handleCopy = useCallback(async (event: React.MouseEvent) => {
        const win = (event.currentTarget as Element).ownerDocument.defaultView;
        if (!win) return;
        try {
            await win.navigator.clipboard.writeText(detailsText);
        } catch (copyError) {
            logger(`RenderErrorNotice: copy failed: ${String(copyError)}`, 1);
            return;
        }
        if (copiedTimer.current) win.clearTimeout(copiedTimer.current.id);
        setCopied(true);
        copiedTimer.current = { win, id: win.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS) };
    }, [detailsText]);

    const reportLabel = reportRenderError ? 'Report problem' : openExternalUrl ? 'Email support' : null;
    const links = (
        <div className="beaver-render-error-links">
            {reportLabel && (
                <button
                    type="button"
                    className="beaver-render-error-link"
                    onClick={handleReport}
                    title={reportRenderError ? undefined : SUPPORT_EMAIL}
                >
                    {reportLabel}
                </button>
            )}
            <button
                type="button"
                className="beaver-render-error-link"
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={() => setDetailsOpen((open) => !open)}
            >
                Details
                <Icon icon={detailsOpen ? ArrowDownIcon : ArrowRightIcon} />
            </button>
        </div>
    );
    const detailsBody = detailsOpen && (
        <div id={detailsId} className="beaver-render-error-details">
            <dl>
                {threadId && (<><dt>Chat ID</dt><dd>{threadId}</dd></>)}
                {runId && (<><dt>Message ID</dt><dd>{runId}</dd></>)}
                <dt>Error</dt><dd>{errorText(error)}</dd>
            </dl>
            <button type="button" className="beaver-render-error-link" onClick={handleCopy}>
                <Icon icon={copied ? TickIcon : CopyIcon} />
                {copied ? 'Copied' : 'Copy details'}
            </button>
        </div>
    );

    if (layout === 'page') {
        return (
            <div role="alert" className={`beaver-render-error beaver-render-error-page ${className}`}>
                <Icon icon={AlertIcon} size={22} className="beaver-render-error-icon" />
                <div className="display-flex flex-col gap-1">
                    <span className="font-color-primary font-medium">{summary}</span>
                    {detail && <span className="font-color-secondary text-sm">{detail}</span>}
                </div>
                {actions && <div className="beaver-render-error-actions">{actions}</div>}
                {links}
                {detailsBody}
            </div>
        );
    }

    return (
        <div className={`min-w-0 ${className}`}>
            <div role="alert" className="beaver-render-error beaver-render-error-card">
                {/* The icon shares the title's row, so the two stay centred on each other. */}
                <div className="beaver-render-error-title">
                    <Icon icon={AlertIcon} size={16} className="beaver-render-error-icon" />
                    <span className="font-color-primary font-medium">{summary}</span>
                </div>
                <div className="beaver-render-error-body">
                    {detail && <span className="font-color-secondary">{detail}</span>}
                    {actions && <div className="beaver-render-error-actions">{actions}</div>}
                    {links}
                    {detailsBody}
                </div>
            </div>
        </div>
    );
};

export interface RenderErrorBoundaryProps extends Omit<RenderErrorNoticeProps, 'error' | 'actions'> {
    children?: React.ReactNode;
    /** Names the boundary in the log ("message", "thread", …). */
    scope: string;
    /** A value that clears the error when it changes; see `ErrorBoundary`. */
    resetKey?: unknown;
    /** The client's way out for the notice; `reset` renders the children again. */
    actions?: (reset: () => void) => React.ReactNode;
    /** Places the notice in a surface of its own (a full-pane fallback). */
    wrapFallback?: (notice: React.ReactNode) => React.ReactNode;
}

/**
 * An error boundary that shows {@link RenderErrorNotice} in place of children
 * that threw while rendering, and logs the error once per distinct error and ids,
 * since every change of `resetKey` retries children that may throw again.
 */
const RenderErrorBoundary: React.FC<RenderErrorBoundaryProps> = ({
    children,
    scope,
    resetKey,
    actions,
    wrapFallback,
    ...notice
}) => {
    const lastLogged = useRef<string | null>(null);
    const { threadId, runId } = notice;
    const handleError = useCallback((error: Error, info: React.ErrorInfo) => {
        // A boundary can outlive a thread switch; the same error on another
        // thread is a new report.
        const key = `${threadId ?? ''}|${runId ?? ''}|${errorText(error)}`;
        if (lastLogged.current === key) return;
        lastLogged.current = key;
        logRenderError(scope, error, info, { threadId, runId });
    }, [scope, threadId, runId]);

    return (
        <ErrorBoundary
            resetKey={resetKey}
            onError={handleError}
            fallback={({ error, reset }) => {
                const noticeElement = (
                    <RenderErrorNotice {...notice} error={error} actions={actions?.(reset)} />
                );
                return wrapFallback ? wrapFallback(noticeElement) : noticeElement;
            }}
        >
            {children}
        </ErrorBoundary>
    );
};

export default RenderErrorBoundary;
