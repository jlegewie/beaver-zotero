import { describe, expect, it } from 'vitest';
import {
    ConnectionFailureEvidence,
    presentConnectionFailure,
} from '../../../src/services/connectionFailure';

const opening1006: ConnectionFailureEvidence = {
    stage: 'opening',
    closeCode: 1006,
    closeReason: '',
    wasClean: false,
    socketOpened: false,
    readyReceived: false,
    timedOut: false,
    navigatorOnline: true,
};

describe('presentConnectionFailure', () => {
    it('does not claim that an unexplained 1006 is a network block', () => {
        const result = presentConnectionFailure(opening1006);

        expect(result.message).toBe('Could not connect to Beaver.');
        expect(result.details).toContain(
            'server may be temporarily unavailable',
        );
        expect(result.details).toContain('may be blocking');
        expect(result.details).not.toContain('appears to be blocking');
    });

    it('prioritizes possible WebSocket blocking when fresh HTTPS diagnostics succeed', () => {
        const result = presentConnectionFailure(opening1006, {
            apiReachable: true,
            receivedHttpResponse: true,
            status: 204,
            durationMs: 20,
        });

        expect(result.details).toContain("Beaver's regular API is reachable");
        expect(result.details).toContain('may be blocking WebSocket traffic');
        expect(result.details).not.toContain(
            'server may be temporarily unavailable',
        );
    });

    it('reports broad reachability causes when the diagnostic POST cannot connect', () => {
        const result = presentConnectionFailure(opening1006, {
            apiReachable: false,
            receivedHttpResponse: false,
            durationMs: 8_000,
        });

        expect(result.details).toContain(
            'server may be temporarily unavailable',
        );
        expect(result.details).toContain('internet connection');
    });

    it('distinguishes a mid-run interruption from an opening failure', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'mid_run',
            socketOpened: true,
            readyReceived: true,
        });

        expect(result.message).toBe(
            'The connection was lost before the run finished.',
        );
        expect(result.details).toContain('live connection was interrupted');
    });

    it('does not blame server reachability for an auth-session timeout', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'auth',
            closeCode: null,
            timedOut: true,
        });

        expect(result.details).toContain('checking your sign-in session');
        expect(result.details).not.toContain('firewall');
    });

    it('reports the offline cause for an auth-stage failure without a troubleshooting link', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'auth',
            closeCode: null,
            navigatorOnline: false,
        });

        expect(result.message).toBe('Could not start the connection.');
        expect(result.details).toContain('appears to be offline');
        expect(result.details).not.toContain('connection-troubleshooting');
    });

    it('points at the network path when an auth-stage failure and the follow-up HTTPS probe both fail', () => {
        const result = presentConnectionFailure(
            {
                ...opening1006,
                stage: 'auth',
                closeCode: null,
            },
            {
                apiReachable: false,
                receivedHttpResponse: false,
                durationMs: 5_000,
            },
        );

        expect(result.message).toBe('Could not start the connection.');
        expect(result.details).toContain('could not reach Beaver either');
        expect(result.details).toContain('firewall');
        expect(result.details).toContain('connection-troubleshooting');
        expect(result.details).not.toContain('sign out');
    });

    it('blames the sign-in session or a network filter when the auth-stage diagnostic shows the API is reachable', () => {
        const result = presentConnectionFailure(
            {
                ...opening1006,
                stage: 'auth',
                closeCode: null,
            },
            {
                apiReachable: true,
                receivedHttpResponse: true,
                status: 200,
                durationMs: 30,
            },
        );

        expect(result.message).toBe('Could not start the connection.');
        expect(result.details).toContain("Beaver's API is reachable");
        expect(result.details).toContain('sign out and sign back in');
        expect(result.details).toContain('connection-troubleshooting');
    });

    it('keeps the cause open when an auth-stage follow-up check receives an unexpected response', () => {
        const result = presentConnectionFailure(
            {
                ...opening1006,
                stage: 'auth',
                closeCode: null,
            },
            {
                apiReachable: false,
                receivedHttpResponse: true,
                status: 503,
                durationMs: 40,
            },
        );

        expect(result.message).toBe('Could not start the connection.');
        expect(result.details).toContain('unexpected response (HTTP 503)');
        expect(result.details).toContain('may be intercepting');
        expect(result.details).toContain('connection-troubleshooting');
        expect(result.details).not.toContain('sign out');
    });

    it('gives sign-out advice for an auth-stage failure with no diagnostic yet', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'auth',
            closeCode: null,
        });

        expect(result.message).toBe('Could not start the connection.');
        expect(result.details).toContain('could not check your sign-in session');
        expect(result.details).toContain('sign out and sign back in');
        expect(result.details).toContain('connection-troubleshooting');
    });

    it('preserves the timed-out lead for an auth-stage failure with a reachable-API diagnostic', () => {
        const result = presentConnectionFailure(
            {
                ...opening1006,
                stage: 'auth',
                closeCode: null,
                timedOut: true,
            },
            {
                apiReachable: true,
                receivedHttpResponse: true,
                status: 200,
                durationMs: 30,
            },
        );

        expect(result.details).toContain('Beaver timed out while checking your sign-in session');
        expect(result.details).toContain("Beaver's API is reachable");
        expect(result.details).toContain('connection-troubleshooting');
    });

    it('uses the standards meaning of policy code 1008 without claiming auth failure', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'awaiting_ready',
            closeCode: 1008,
            socketOpened: true,
        });

        expect(result.details).toContain('policy or account check');
        expect(result.details).not.toContain('could not verify your account');
    });

    it('surfaces the server-supplied close reason when one is present', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'awaiting_ready',
            closeCode: 1008,
            closeReason: 'Authentication failed. Please try again.',
            socketOpened: true,
        });

        expect(result.details).toContain(
            'The server reported: "Authentication failed. Please try again."',
        );
        expect(result.details).toContain('(error code 1008)');
    });

    it('neutralizes markup in a peer-supplied close reason so it cannot become a link', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'mid_run',
            closeCode: 4400,
            closeReason: 'Blocked. <a href="https://evil.example">Click to fix</a> now',
            socketOpened: true,
            readyReceived: true,
        });

        // The renderer parses <a href> into clickable links that invoke
        // Zotero.launchURL — peer text must arrive with no markup at all.
        expect(result.details).not.toContain('<');
        expect(result.details).not.toContain('>');
        expect(result.details).not.toContain('evil.example');
        expect(result.details).toContain('The server reported: "Blocked. Click to fix now"');
    });

    it('keeps only the trusted link when a reason with markup meets a linked branch', () => {
        // Unknown close code in the 3xxx range takes the generic fallback,
        // which appends the trusted troubleshooting link after the sanitized
        // server text.
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'mid_run',
            closeCode: 3333,
            closeReason: '<a href="https://evil.example">helpful link</a>',
            socketOpened: true,
            readyReceived: true,
        });

        expect(result.details).not.toContain('evil.example');
        const anchorCount = (result.details.match(/<a /g) ?? []).length;
        expect(anchorCount).toBe(1);
        expect(result.details).toContain('connection-troubleshooting');
    });

    it('flattens control characters and bounds a hostile close reason', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'mid_run',
            closeCode: 4402,
            closeReason: 'line one\nline two' + 'x'.repeat(300),
            socketOpened: true,
            readyReceived: true,
        });

        expect(result.details).toContain('The server reported: "line one line two');
        expect(result.details).not.toContain('\n');
        expect(result.details.length).toBeLessThan(400);
    });

    it('does not assert Beaver responded when the diagnostic got an unexpected HTTP response', () => {
        const result = presentConnectionFailure(opening1006, {
            apiReachable: false,
            receivedHttpResponse: true,
            status: 403,
            durationMs: 120,
        });

        expect(result.details).toContain('unexpected response (HTTP 403)');
        expect(result.details).toContain('intercepting');
        expect(result.details).toContain('connection-troubleshooting');
        expect(result.details).not.toContain("Beaver's server responded");
    });

    it('considers network interference for a handshake that opened but timed out', () => {
        const result = presentConnectionFailure(
            {
                ...opening1006,
                stage: 'awaiting_ready',
                closeCode: null,
                socketOpened: true,
                timedOut: true,
            },
            {
                apiReachable: true,
                receivedHttpResponse: true,
                status: 202,
                durationMs: 40,
            },
        );

        expect(result.message).toBe('Could not finish connecting to Beaver.');
        expect(result.details).toContain('sign-in handshake did not complete');
        expect(result.details).toContain('WebSocket');
        expect(result.details).toContain('connection-troubleshooting');
        expect(result.details).toContain('sign out and sign back in');
    });

    it('labels the numeric suffix "error code" to match the troubleshooting docs', () => {
        const result = presentConnectionFailure({
            ...opening1006,
            stage: 'mid_run',
            socketOpened: true,
            readyReceived: true,
        });

        expect(result.details).toContain('(error code 1006)');
        expect(result.details).not.toContain('connection code');
    });
});
