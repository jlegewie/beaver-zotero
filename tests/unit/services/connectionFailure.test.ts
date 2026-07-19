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
});
