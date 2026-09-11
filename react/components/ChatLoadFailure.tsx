import React from 'react';
import Button from '@beaver/agent-ui/primitives/Button';
import type { ChatLoadError } from '../utils/chatLoadError';

/** Shared failure state for empty lists and lists retaining previously loaded rows. */
export default function ChatLoadFailure({ error, retry, loading = false }: {
    error: ChatLoadError;
    retry: () => void;
    loading?: boolean;
}) {
    const title = error.kind === 'offline' ? "You're offline"
        : error.kind === 'session' ? 'Your session was rejected'
        : "Couldn't load chats";
    const message = error.kind === 'offline' ? 'Reconnect to load your chats.'
        : error.kind === 'session' ? 'Try again. If this continues, sign out and sign in again from Beaver settings.'
        : error.kind === 'transient' ? 'The server is temporarily unavailable. Try again shortly.'
        : 'Something went wrong while loading your chats. Please try again.';
    return (
        <div role="alert" className="display-flex flex-col items-center gap-2 py-3 px-3 text-center">
            <span className="font-color-primary font-semibold text-sm">{title}</span>
            <span className="font-color-tertiary text-sm">{message}</span>
            <Button variant="outline" type="button" onClick={retry} disabled={loading}>Try again</Button>
        </div>
    );
}
