/**
 * Render helpers for /command tokens in stored user messages.
 *
 * Pill data (`command`, `title`) is self-contained in the prompt's `actions`
 * field, so rendering stays pure and client-agnostic — no host access needed.
 * The token matching itself lives in the React-free `utils/slashCommands.ts`.
 */

import React from 'react';
import type { PromptAction } from '../../agents/types';
import { splitContentBySlashTokens } from '../../utils/slashCommands';

/**
 * Render message content with recognized `/command` tokens styled as pills.
 * Plain-text segments are emitted as-is (the parent preserves whitespace via
 * `white-space: pre-wrap`); unmatched or malformed tokens degrade to raw text.
 */
export function renderContentWithSlashPills(
    content: string,
    actions: PromptAction[],
): React.ReactNode[] {
    return splitContentBySlashTokens(content, actions).map((segment, i) =>
        segment.action ? (
            <span key={i} className="beaver-slash-command" title={segment.action.title}>
                {segment.text}
            </span>
        ) : (
            <React.Fragment key={i}>{segment.text}</React.Fragment>
        )
    );
}
