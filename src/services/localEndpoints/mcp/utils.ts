import type { TimeoutContext } from '../../agentDataProvider/timeout';

export function generateRequestId(): string {
    if (typeof Zotero !== 'undefined' && Zotero.Utilities?.randomString) {
        return Zotero.Utilities.randomString(16);
    }
    return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

export function mcpError(error: unknown) {
    return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
    };
}

export function buildNoopTimeoutContext(): TimeoutContext {
    return {
        signal: new AbortController().signal,
        timeoutSeconds: 120,
        startTime: Date.now(),
    };
}
