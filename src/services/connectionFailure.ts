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

function codeSuffix(code: number | null): string {
    return code === null ? '' : ` (connection code ${code})`;
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
            "Beaver's regular API is reachable, but its live connection could not be established. " +
            'A VPN, proxy, firewall, antivirus, or managed network may be blocking WebSocket traffic, ' +
            "or Beaver's live-connection endpoint may be temporarily unavailable." +
            troubleshootingLink +
            suffix
        );
    }

    if (diagnostic?.receivedHttpResponse) {
        const status = diagnostic.status ? ` (HTTP ${diagnostic.status})` : '';
        return (
            `Beaver's server responded${status}, but could not accept the diagnostic request. ` +
            'The service or its live-connection endpoint may be temporarily unavailable. Please try again in a moment.' +
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
            return 'The server or client closed the connection because it was shutting down or restarting.';
        case 1002:
            return 'The live connection ended because of a WebSocket protocol error.';
        case 1003:
            return 'The live connection ended because unsupported data was received.';
        case 1007:
            return 'The live connection ended because invalid message data was received.';
        case 1008:
            return 'The server rejected the live connection because of a policy or account check.';
        case 1009:
            return 'The live connection ended because a message was too large.';
        case 1010:
            return 'The live connection could not negotiate a required WebSocket extension.';
        case 1011:
            return "Beaver's server encountered an internal error. Please try again in a moment.";
        case 1012:
            return "Beaver's server is restarting. Please try again in a moment.";
        case 1013:
            return "Beaver's server is temporarily busy or unavailable. Please try again in a moment.";
        case 1014:
            return 'A gateway in front of Beaver received an invalid response. Please try again in a moment.';
        case 1015:
            return (
                'The secure TLS handshake failed. A certificate problem, VPN, proxy, antivirus, or ' +
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
        const details = evidence.timedOut
            ? 'Beaver timed out while checking your sign-in session. Please try again; if it continues, sign out and sign back in.'
            : 'Beaver could not check your sign-in session. Please try again; if it continues, sign out and sign back in.';
        return { message: 'Could not start the connection.', details };
    }

    if (evidence.timedOut) {
        if (!evidence.socketOpened) {
            return {
                message: 'Could not connect to Beaver.',
                details: openingFailureDetails(evidence, diagnostic),
            };
        }
        return {
            message: 'Beaver did not finish starting the live connection.',
            details:
                'The server accepted the connection but did not finish the sign-in handshake in time. ' +
                'Please try again; if the problem continues, sign out and sign back in.',
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
            ? " Beaver's regular API is still reachable, so a temporary live-connection service issue, WebSocket interruption, or network/security software may be responsible."
            : diagnostic
              ? ' This can be caused by a temporary server or internet interruption, VPN, proxy, firewall, or security software.'
              : ' This can be caused by a temporary server or internet interruption, VPN, proxy, firewall, or security software.';
        return {
            message: evidence.readyReceived
                ? 'The connection was lost before the run finished.'
                : 'Could not finish connecting to Beaver.',
            details:
                prefix +
                reachability +
                troubleshootingLink +
                codeSuffix(evidence.closeCode),
        };
    }

    if (evidence.closeCode !== null) {
        const standard = standardCloseDetails(evidence.closeCode);
        if (standard) {
            return {
                message: evidence.readyReceived
                    ? 'The connection was lost before the run finished.'
                    : 'Could not finish connecting to Beaver.',
                details: standard + codeSuffix(evidence.closeCode),
            };
        }

        if (evidence.closeCode >= 4000 && evidence.closeCode <= 4999) {
            return {
                message: evidence.readyReceived
                    ? 'The server ended the connection before the run finished.'
                    : 'The server rejected the connection.',
                details: `Beaver's server ended the live connection.${codeSuffix(evidence.closeCode)}`,
            };
        }
    }

    return {
        message: evidence.readyReceived
            ? 'The connection was lost before the run finished.'
            : 'Could not connect to Beaver.',
        details:
            'A temporary server, internet, VPN, proxy, firewall, or security-software issue may be responsible.' +
            troubleshootingLink +
            codeSuffix(evidence.closeCode),
    };
}
