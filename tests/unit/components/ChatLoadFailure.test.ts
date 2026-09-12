// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatLoadFailure from '../../../react/components/ChatLoadFailure';
import { useChatReconnect } from '../../../react/hooks/useChatReconnect';
import { classifyChatLoadError } from '../../../react/utils/chatLoadError';
import { SessionRefreshError } from '@beaver/agent-core/types/apiErrors';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
});

describe('chat failure recovery', () => {
    it.each(['offline', 'transient', 'session', 'generic'] as const)('renders an actionable %s failure', kind => {
        const retry = vi.fn();
        act(() => root.render(React.createElement(ChatLoadFailure, { error: { kind }, retry })));
        expect(container.querySelector('[role="alert"]')).not.toBeNull();
        expect(container.textContent).not.toContain('No chats');
        if (kind === 'session') expect(container.textContent).toContain('sign out and sign in');
        act(() => container.querySelector('button')!.click());
        expect(retry).toHaveBeenCalledTimes(1);
    });
    it('uses native offline state without hiding unexpected errors', () => {
        vi.stubGlobal('Services', { io: { offline: true } });
        expect(classifyChatLoadError(new SessionRefreshError())).toEqual({ kind: 'offline' });
        expect(classifyChatLoadError(new Error('Invalid JSON'))).toEqual({ kind: 'generic' });
    });
    it('retries on reconnection and releases the observer after recovery or unmount', () => {
        const addObserver = vi.fn();
        const removeObserver = vi.fn();
        vi.stubGlobal('Services', { obs: { addObserver, removeObserver } });
        const retry = vi.fn();
        function Probe({ failed }: { failed: boolean }) { useChatReconnect(retry, failed); return null; }
        act(() => root.render(React.createElement(Probe, { failed: true })));
        const observer = addObserver.mock.calls[0][0];
        observer.observe(null, '', 'offline');
        expect(retry).not.toHaveBeenCalled();
        observer.observe(null, '', 'online');
        expect(retry).toHaveBeenCalledTimes(1);
        act(() => root.render(React.createElement(Probe, { failed: false })));
        expect(removeObserver).toHaveBeenCalledWith(observer, 'network:offline-status-changed');
        act(() => root.render(React.createElement(Probe, { failed: true })));
        act(() => root.unmount());
        expect(removeObserver).toHaveBeenCalledTimes(2);
    });
});
