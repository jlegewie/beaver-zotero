/**
 * Render helpers for /command tokens in stored user messages.
 *
 * Pill data (`command`, `title`, `prompt`, `category`) is self-contained in
 * the prompt's `actions` field, so rendering stays pure and client-agnostic —
 * the hover card is built entirely from persisted data. The only
 * client-specific behavior (clicking a pill to edit the action) goes through
 * the optional `navigation.openActionSettings` host method. The token
 * matching itself lives in the React-free `utils/slashCommands.ts`.
 */

import React from 'react';
import type { PromptAction } from '../../agents/types';
import { splitContentBySlashTokens } from '../../utils/slashCommands';
import { ChipWithPopup } from './requestChips/ChipPopup';
import { buildActionPopup } from './requestChips/actionPopup';
import { getHost } from '../../host';

/**
 * Render message content with recognized `/command` tokens styled as pills.
 * Plain-text segments are emitted as-is (the parent preserves whitespace via
 * `white-space: pre-wrap`); unmatched or malformed tokens degrade to raw text.
 *
 * Each pill shows a hover card (action title, prompt preview, edit hint) and
 * opens the action in the host's settings on click. The click stops
 * propagation so it doesn't also trigger the surrounding message's
 * click-to-edit behavior.
 */
export function renderContentWithSlashPills(
    content: string,
    actions: PromptAction[],
): React.ReactNode[] {
    return splitContentBySlashTokens(content, actions).map((segment, i) => {
        const action = segment.action;
        if (!action) {
            return <React.Fragment key={i}>{segment.text}</React.Fragment>;
        }
        return (
            <ChipWithPopup
                key={i}
                popup={buildActionPopup({
                    title: action.title,
                    command: action.command,
                    prompt: action.prompt,
                    category: action.category,
                })}
            >
                <span
                    className="beaver-slash-command beaver-slash-command-clickable"
                    onClick={(e) => {
                        // Gecko dispatches click for non-primary buttons too.
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        getHost().navigation?.openActionSettings?.(action.action_id);
                    }}
                >
                    {segment.text}
                </span>
            </ChipWithPopup>
        );
    });
}
