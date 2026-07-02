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
 *  otherwise a token derived from the title. */
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
        p.argumentHint === b[i].argumentHint
    );
}

/** Whether `content` contains `/command` as a properly bounded token. */
export function hasSlashToken(content: string, command: string): boolean {
    return buildTokenRegex([command]).test(content);
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
