/**
 * Pure slash-command token utilities shared by message composition (input
 * atoms, Lexical editor) and chat-history rendering.
 *
 * This module must stay React-free and Zotero-free: it is imported by the
 * client-agnostic render layer as well as by composition code.
 */

import type { PromptAction } from '../agents/types';
import type { Action, ActionTargetType } from '../types/actions';

/** A /slash-command pill present in the editor, with the action identity it
 *  carries so the send path can resolve it back to the action's prompt. */
export interface SlashCommandDescriptor {
    commandName: string;
    actionId: string;
    targetType?: ActionTargetType;
    /** Human-readable action title, shown as a native hover tooltip. */
    title?: string;
    /** Ghost text shown after the inserted pill to indicate expected arguments. */
    argumentHint?: string;
    /** The action no longer exists (deleted since the message was sent). The
     *  pill renders greyed out and is not clickable. */
    missing?: boolean;
    /** The pill was rebuilt from a sent message's persisted wire actions
     *  (message edit overlay). On resubmit, such pills reuse their persisted
     *  wire entry; pills without this flag resolve fresh. Never set for pills
     *  inserted via the slash menu — a reinserted pill with the same /command
     *  must not be mistaken for the original one. */
    persisted?: boolean;
}

/** Turn an action title into a single `/command` token (e.g. "Summarize Paper"
 *  → "summarize-paper"). The slash menu closes on whitespace, so the token must
 *  not contain spaces. */
export const toSlashToken = (title: string): string =>
    title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'action';

/** The `/command` token for an action: its explicit `name` when set (names
 *  must never contain whitespace; guard anyway against hand-edited prefs),
 *  otherwise a token derived from the title. An empty name means "explicitly
 *  cleared, derive from the title" (see Action.name). */
export const getActionCommand = (action: Pick<Action, 'name' | 'title'>): string => {
    const name = action.name?.trim();
    return name && !/\s/.test(name) ? name : toSlashToken(action.title);
};

const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the token-boundary regex for a set of commands. A token only matches
 * when preceded by start-of-string, whitespace, or open punctuation (so
 * `https://x.test/summarize` never matches) and not followed by a word char or
 * hyphen (so `/sum` never matches inside `/summarize-paper`). The leading
 * boundary is a lookbehind, so it is never part of the match.
 *
 * Commands are sorted longest-first so overlapping tokens prefer the longer
 * match. This is the ONE place token-boundary matching is defined; use the
 * helpers below instead of interpreting match spans elsewhere.
 */
const buildTokenRegex = (commands: string[]): RegExp => {
    const alternatives = [...commands]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
    return new RegExp(`(?<=^|[\\s([{])\\/(${alternatives})(?![\\w-])`, 'g');
};

export interface CommandTokenSegment<T> {
    /** Literal text of this segment. For token segments, exactly `/command`. */
    text: string;
    /** Set when this segment is a recognized slash-command token. */
    match?: T;
}

/**
 * Split message content into plain-text and slash-token segments against any
 * command-carrying items (send-time `PromptAction`s, editor pill descriptors).
 * Boundary characters stay in the surrounding text segments; token segments
 * carry exactly `/command` plus the matching item.
 */
export function splitContentByCommandTokens<T>(
    content: string,
    items: T[],
    getCommand: (item: T) => string,
): CommandTokenSegment<T>[] {
    if (!content || items.length === 0) {
        return [{ text: content }];
    }
    const byCommand = new Map(items.map(item => [getCommand(item), item]));
    const regex = buildTokenRegex([...byCommand.keys()]);

    const segments: CommandTokenSegment<T>[] = [];
    let cursor = 0;
    for (const match of content.matchAll(regex)) {
        const index = match.index ?? 0;
        if (index > cursor) {
            segments.push({ text: content.slice(cursor, index) });
        }
        segments.push({ text: match[0], match: byCommand.get(match[1]) });
        cursor = index + match[0].length;
    }
    if (cursor < content.length || segments.length === 0) {
        segments.push({ text: content.slice(cursor) });
    }
    return segments;
}

export interface SlashContentSegment {
    /** Literal text of this segment. For token segments, exactly `/command`. */
    text: string;
    /** Set when this segment is a recognized slash-command token. */
    action?: PromptAction;
}

/**
 * Split message content into plain-text and slash-token segments. Boundary
 * characters stay in the surrounding text segments; token segments carry
 * exactly `/command` plus the matching action.
 */
export function splitContentBySlashTokens(
    content: string,
    actions: PromptAction[],
): SlashContentSegment[] {
    return splitContentByCommandTokens(content, actions, a => a.command)
        .map(s => ({ text: s.text, action: s.match }));
}

/** Value equality for pill descriptor lists (used to avoid state echo loops). */
export function slashDescriptorsEqual(
    a: SlashCommandDescriptor[],
    b: SlashCommandDescriptor[],
): boolean {
    return a.length === b.length && a.every((p, i) =>
        p.commandName === b[i].commandName &&
        p.actionId === b[i].actionId &&
        p.targetType === b[i].targetType &&
        p.title === b[i].title &&
        p.argumentHint === b[i].argumentHint &&
        (p.missing ?? false) === (b[i].missing ?? false) &&
        (p.persisted ?? false) === (b[i].persisted ?? false)
    );
}

/** Whether `content` contains `/command` as a properly bounded token. */
export function hasSlashToken(content: string, command: string): boolean {
    return buildTokenRegex([command]).test(content);
}

/**
 * Return content that visibly invokes every structured prompt action. Normal
 * composer sends already include `/command` tokens in the text; direct action
 * launchers may provide the structured action separately, so this helper
 * prepends any missing tokens while preserving the user's text.
 */
export function ensurePromptActionTokens(
    content: string,
    actions: PromptAction[] | undefined,
): string {
    if (!actions?.length) return content;
    const missingTokens = actions
        .filter(a => !hasSlashToken(content, a.command))
        .map(a => `/${a.command}`);
    if (missingTokens.length === 0) return content;
    const prefix = missingTokens.join(' ');
    if (content.trim().length === 0) return prefix;
    return `${prefix} ${content.trimStart()}`;
}

/**
 * Rebuild editor pill descriptors from a message's persisted wire actions,
 * used when a sent message is opened for editing. Each descriptor keeps the
 * persisted `command` (it must match the token in the message content), and is
 * re-linked to the current action definition: by id first (ids survive
 * renames), then by the action's current `/command` token (covers a deleted
 * and re-created action). Actions that no longer resolve are marked `missing`
 * so the pill renders greyed out.
 */
export function promptActionsToDescriptors(
    promptActions: PromptAction[] | undefined,
    availableActions: Action[],
): SlashCommandDescriptor[] {
    if (!promptActions?.length) return [];
    return promptActions.map((pa) => {
        const matched = availableActions.find(a => a.id === pa.action_id)
            ?? availableActions.find(a => getActionCommand(a) === pa.command);
        if (!matched) {
            return {
                commandName: pa.command,
                actionId: pa.action_id,
                targetType: pa.target_type,
                title: pa.title,
                missing: true,
                persisted: true,
            };
        }
        return {
            commandName: pa.command,
            actionId: matched.id,
            targetType: pa.target_type,
            title: matched.title,
            argumentHint: matched.argumentHint,
            persisted: true,
        };
    });
}

/**
 * Keep only the actions whose `/command` token still appears in `content`.
 * Used when resubmitting an edited message, so actions whose tokens the user
 * deleted don't ride along.
 */
export function filterPromptActionsForContent(
    actions: PromptAction[] | undefined,
    content: string,
): PromptAction[] | undefined {
    if (!actions?.length) return undefined;
    const kept = actions.filter(a => hasSlashToken(content, a.command));
    return kept.length > 0 ? kept : undefined;
}
