/**
 * Client-agnostic connection-failure evidence and user-facing classification.
 *
 * WebSocket close codes describe how a connection ended, not necessarily why.
 * In particular, 1006 only means that no close frame was received. Classification
 * therefore combines the code with lifecycle phase and a fresh HTTPS reachability
 * check, and keeps ambiguous causes explicitly tentative.
 */

export type ConnectionFailureStage =
    | 'auth'
    | 'opening'
    | 'authenticating'
    | 'awaiting_ready'
    | 'mid_run';

export interface ConnectionFailureEvidence {
    stage: ConnectionFailureStage;
    closeCode: number | null;
    closeReason: string;
    wasClean: boolean | null;
    socketOpened: boolean;
    readyReceived: boolean;
    timedOut: boolean;
    navigatorOnline: boolean | null;
    errorName?: string;
    /** How long the socket had been open when the failure was observed (null if it never opened). */
    wsUptimeMs?: number | null;
    /**
     * Time since the last WebSocket message arrived (null if none arrived).
     * Separates idle-timeout kills by proxies/load balancers from abrupt
     * mid-stream cuts.
     */
    msSinceLastWsMessageMs?: number | null;
}

/** navigator.onLine when available; null in contexts without a navigator global. */
export function navigatorOnlineState(): boolean | null {
    return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
        ? navigator.onLine
        : null;
}

/**
 * Evidence with conservative defaults for failure paths that lack live
 * attempt state. socketOpened/readyReceived are inferred from the stage;
 * timing fields stay null because no attempt timestamps exist.
 */
export function baselineConnectionEvidence(
    stage: ConnectionFailureStage,
    overrides: Partial<ConnectionFailureEvidence> = {},
): ConnectionFailureEvidence {
    return {
        stage,
        closeCode: null,
        closeReason: '',
        wasClean: null,
        socketOpened: stage !== 'auth' && stage !== 'opening',
        readyReceived: stage === 'mid_run',
        timedOut: false,
        navigatorOnline: navigatorOnlineState(),
        wsUptimeMs: null,
        msSinceLastWsMessageMs: null,
        ...overrides,
    };
}

/**
 * 1005/1006 are synthetic absence-of-close-frame codes: the transport dropped
 * without either side sending a close frame. They mark abrupt transport loss
 * (network interruption, proxy/DPI kill, instance scale-down) as opposed to a
 * deliberate close or an application-level rejection.
 */
export function isAbruptTransportCloseCode(code: number | null): boolean {
    return code === 1005 || code === 1006;
}

/**
 * Whether a failed connect attempt is worth retrying automatically.
 *
 * Only pre-`ready` transport failures qualify: an abrupt transport drop
 * (1005/1006) while opening, authenticating, or awaiting ready, or a connect
 * attempt that timed out after the socket started opening. These are the
 * failures that a cold-starting instance, a scale event, or a momentary
 * network block produce, and they routinely succeed on a quick retry.
 *
 * Auth-stage failures (the session lookup itself), policy rejections (1008),
 * and application-level errors are excluded — they will not fix themselves
 * and should surface immediately.
 */
export function isRetryablePreReadyConnectFailure(
    evidence: ConnectionFailureEvidence,
): boolean {
    if (
        evidence.stage !== 'opening' &&
        evidence.stage !== 'authenticating' &&
        evidence.stage !== 'awaiting_ready'
    ) {
        return false;
    }
    if (evidence.timedOut) return true;
    return isAbruptTransportCloseCode(evidence.closeCode);
}

/**
 * Compact wire fields attached to the WebSocket auth message when a connect
 * succeeds after client-side auto-retry. Lets the backend measure recovered
 * flakes without a separate diagnostics POST.
 */
export interface ConnectRecoveryAuthFields {
    connect_attempts: number;
    last_connect_failure?: {
        stage: ConnectionFailureStage;
        close_code: number | null;
        timed_out: boolean;
    };
}

/**
 * Build auth-message recovery fields for a successful connect that followed
 * one or more auto-retries. Returns undefined on first-try success.
 */
export function connectRecoveryAuthFields(
    attemptsMade: number,
    evidence: ConnectionFailureEvidence | null | undefined,
): ConnectRecoveryAuthFields | undefined {
    if (attemptsMade <= 1) return undefined;
    return {
        connect_attempts: attemptsMade,
        ...(evidence
            ? {
                last_connect_failure: {
                    stage: evidence.stage,
                    close_code: evidence.closeCode,
                    timed_out: evidence.timedOut,
                },
            }
            : {}),
    };
}

export interface ConnectionDiagnosticResult {
    /** Whether the post-failure HTTPS request reached Beaver and returned 2xx. */
    apiReachable: boolean;
    /** True when an HTTP response arrived, including a non-2xx response. */
    receivedHttpResponse: boolean;
    status?: number;
    durationMs: number;
}

export interface ConnectionFailurePresentation {
    message: string;
    details: string;
}

export const CONNECTION_TROUBLESHOOTING_URL =
    'https://www.beaverapp.ai/docs/connection-troubleshooting';

const troubleshootingLink = ` See our <a href="${CONNECTION_TROUBLESHOOTING_URL}">connection troubleshooting guide</a> for help.`;

// "error code" matches the wording used on the troubleshooting docs page.
function codeSuffix(code: number | null): string {
    return code === null ? '' : ` (error code ${code})`;
}

/**
 * A close reason supplied by the server (or a middlebox) is often the most
 * specific information available — e.g. "Authentication failed. Please try
 * again." Flatten control characters, neutralize markup, and bound it for
 * display. Markup removal is a hard requirement: the details string is parsed
 * for <a href> links by the renderer, and peer-controlled text must never
 * become a clickable link in privileged UI.
 */
function serverMessageSuffix(reason: string): string {
    // eslint-disable-next-line no-control-regex -- intentionally strips control characters from server text
    const flattened = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    const withoutMarkup = flattened
        .replace(/<[^>]*>/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!withoutMarkup) return '';
    return ` The server reported: "${withoutMarkup.slice(0, 140)}".`;
}

function openingFailureDetails(
    evidence: ConnectionFailureEvidence,
    diagnostic?: ConnectionDiagnosticResult,
): string {
    const suffix = codeSuffix(evidence.closeCode);

    if (evidence.navigatorOnline === false) {
        return `Your device appears to be offline. Reconnect to the internet and try again.${suffix}`;
    }

    if (diagnostic?.apiReachable) {
        return (
            "Beaver's server is reachable, but the live connection could not be established. " +
            'A VPN, proxy, firewall, antivirus, or managed network may be blocking WebSocket traffic.' +
            troubleshootingLink +
            suffix
        );
    }

    if (diagnostic?.receivedHttpResponse) {
        // A non-2xx response proves something answered over HTTPS, but not
        // that it was Beaver — proxy block pages and captive portals respond
        // too. Keep the cause open rather than asserting server trouble.
        const status = diagnostic.status ? ` (HTTP ${diagnostic.status})` : '';
        return (
            `Beaver's live connection could not be established, and a follow-up check received an unexpected response${status}. ` +
            'Beaver may be temporarily unavailable, or a VPN, proxy, firewall, or network filter may be intercepting the connection.' +
            troubleshootingLink +
            suffix
        );
    }

    if (diagnostic && !diagnostic.apiReachable) {
        return (
            'Beaver could not be reached. The server may be temporarily unavailable, or your ' +
            'internet connection, VPN, proxy, firewall, or security software may be preventing access.' +
            troubleshootingLink +
            suffix
        );
    }

    return (
        'Beaver could not establish its live connection. The server may be temporarily unavailable, ' +
        'or a VPN, proxy, firewall, antivirus, or managed network may be blocking the connection.' +
        troubleshootingLink +
        suffix
    );
}

function standardCloseDetails(code: number): string | null {
    switch (code) {
        case 1001:
            return "Beaver's server reported that it is shutting down or restarting. Please try again in a moment.";
        // 1002/1003/1007 all mean data arrived corrupted or in a form one side
        // could not process — in practice most often a proxy, antivirus, or
        // network filter altering traffic, so present them the same way.
        case 1002:
        case 1003:
        case 1007:
            return (
                'The live connection ended because data was corrupted or arrived in an unexpected format. ' +
                'This can happen when a proxy, antivirus, or network filter alters traffic. Please try again.' +
                troubleshootingLink
            );
        case 1008:
            return "Beaver's server rejected the live connection because of a policy or account check. Please try again; if it continues, sign out and sign back in.";
        case 1009:
            return 'The live connection ended because a message was too large to process. Please try again.';
        case 1010:
            return (
                'The live connection ended because a required connection feature could not be negotiated. ' +
                'A proxy or security software may be interfering. Please try again.' +
                troubleshootingLink
            );
        case 1011:
            return "Beaver's server reported an internal error. Please try again in a moment.";
        case 1012:
            return "Beaver's server reported that it is restarting. This usually takes just a moment. Please try again shortly.";
        case 1013:
            return "Beaver's server reported that it is temporarily busy or unavailable. Please try again in a moment.";
        case 1014:
            return "A gateway reported an invalid response from Beaver's server. This is usually temporary. Please try again in a moment.";
        case 1015:
            return (
                'The secure (TLS) connection failed. A certificate problem, VPN, proxy, antivirus, or ' +
                'TLS-inspecting network may be interfering with the connection.' +
                troubleshootingLink
            );
        default:
            return null;
    }
}

/** Build truthful, actionable copy from the evidence currently available. */
export function presentConnectionFailure(
    evidence: ConnectionFailureEvidence,
    diagnostic?: ConnectionDiagnosticResult,
): ConnectionFailurePresentation {
    if (evidence.stage === 'auth') {
        const message = 'Could not start the connection to Beaver.';
        if (evidence.navigatorOnline === false) {
            return {
                message,
                details: 'Your device appears to be offline. Reconnect to the internet and try again.',
            };
        }
        const lead = evidence.timedOut
            ? 'Beaver timed out while checking your sign-in session.'
            : 'Beaver could not check your sign-in session.';
        if (diagnostic && !diagnostic.receivedHttpResponse) {
            // Both the sign-in check and the follow-up HTTPS probe failed,
            // which points at the network path rather than the session itself.
            return {
                message,
                details:
                    lead +
                    ' A follow-up check could not reach Beaver either, so your internet connection, VPN, proxy, firewall, or security software may be blocking access.' +
                    troubleshootingLink,
            };
        }
        if (diagnostic?.apiReachable) {
            // Beaver itself answers, so the sign-in service is the outlier —
            // a stale session, or a network filter blocking only that domain.
            return {
                message,
                details:
                    lead +
                    " Beaver's server is reachable, so the problem is likely with the sign-in session itself or a network filter blocking the sign-in service. Please try again; if it continues, sign out and sign back in." +
                    troubleshootingLink,
            };
        }
        if (diagnostic?.receivedHttpResponse) {
            // A non-2xx response proves something answered over HTTPS, but not
            // that it was Beaver — proxy block pages and captive portals
            // respond too — so re-auth advice alone would mislead here.
            const status = diagnostic.status ? ` (HTTP ${diagnostic.status})` : '';
            return {
                message,
                details:
                    lead +
                    ` A follow-up check received an unexpected response${status}, so Beaver may be temporarily unavailable, or a proxy, firewall, or network filter may be intercepting the connection.` +
                    troubleshootingLink,
            };
        }
        return {
            message,
            details:
                lead +
                ' Please try again; if it continues, sign out and sign back in.' +
                troubleshootingLink,
        };
    }

    if (evidence.timedOut) {
        if (!evidence.socketOpened) {
            return {
                message: 'Could not connect to Beaver.',
                details: openingFailureDetails(evidence, diagnostic),
            };
        }
        // The socket opened but the handshake stalled. A middlebox that
        // permits the WebSocket upgrade and then drops frames (common with
        // TLS-inspecting proxies) produces exactly this signature, so do not
        // blame the sign-in session alone.
        const stalledCause = diagnostic?.apiReachable
            ? " Beaver's server is reachable, so a VPN, proxy, firewall, or security software that interferes with live (WebSocket) traffic may be blocking it, or Beaver's live-connection service may be temporarily unavailable."
            : ' This can be caused by a slow or unstable connection, a VPN, proxy, firewall, or security software, or a temporary server issue.';
        return {
            message: 'Could not finish connecting to Beaver.',
            details:
                'The connection opened, but signing in did not finish in time.' +
                stalledCause +
                ' Please try again; if it continues, sign out and sign back in.' +
                troubleshootingLink,
        };
    }

    // 1005/1006 are synthetic absence-of-close-frame signals. They cannot
    // identify refusal, DNS, TLS, proxy interference, server failure, or an
    // interrupted established connection on their own.
    if (evidence.closeCode === 1005 || evidence.closeCode === 1006) {
        if (!evidence.socketOpened) {
            return {
                message: 'Could not connect to Beaver.',
                details: openingFailureDetails(evidence, diagnostic),
            };
        }

        const prefix = evidence.readyReceived
            ? "Beaver's live connection was interrupted."
            : 'The live connection opened but ended before Beaver finished signing in.';
        const reachability = diagnostic?.apiReachable
            ? " Beaver's server is still reachable, so a temporary live-connection service issue, a brief network interruption, or security software may be responsible."
            : ' This can be caused by a temporary server or internet interruption, VPN, proxy, firewall, or security software.';
        return {
            message: evidence.readyReceived
                ? 'The connection was lost before Beaver finished responding.'
                : 'Could not finish connecting to Beaver.',
            details:
                prefix +
                reachability +
                troubleshootingLink +
                codeSuffix(evidence.closeCode),
        };
    }

    // A clean code-1000 close after ready but before a terminal run event is
    // a normal server-initiated closure that arrived mid-run (idle-connection
    // release, graceful shutdown) — not a network or proxy problem, so the
    // copy must not steer the user toward their local setup.
    if (evidence.closeCode === 1000 && evidence.wasClean && evidence.readyReceived) {
        return {
            message: 'The connection ended before Beaver finished responding.',
            details:
                "Beaver's server ended the live connection before the response was finished, so it may be incomplete. This is usually temporary — please try again." +
                serverMessageSuffix(evidence.closeReason),
        };
    }

    if (evidence.closeCode !== null) {
        const standard = standardCloseDetails(evidence.closeCode);
        if (standard) {
            return {
                message: evidence.readyReceived
                    ? 'The connection was lost before Beaver finished responding.'
                    : 'Could not finish connecting to Beaver.',
                details:
                    standard +
                    serverMessageSuffix(evidence.closeReason) +
                    codeSuffix(evidence.closeCode),
            };
        }

        if (evidence.closeCode >= 4000 && evidence.closeCode <= 4999) {
            return {
                message: evidence.readyReceived
                    ? "Beaver's server ended the connection before the response finished."
                    : "Beaver's server rejected the connection.",
                details:
                    "Beaver's server ended the live connection." +
                    serverMessageSuffix(evidence.closeReason) +
                    codeSuffix(evidence.closeCode),
            };
        }
    }

    return {
        message: evidence.readyReceived
            ? 'The connection was lost before Beaver finished responding.'
            : 'Could not connect to Beaver.',
        details:
            'A temporary server, internet, VPN, proxy, firewall, or security-software issue may be responsible.' +
            serverMessageSuffix(evidence.closeReason) +
            troubleshootingLink +
            codeSuffix(evidence.closeCode),
    };
}
