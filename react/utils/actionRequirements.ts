/**
 * Requirement check for the /command pills in the composer.
 *
 * Runs before Send: while a pill's action cannot run on what the message holds,
 * Send stays disabled and the composer shows a one-line hint saying why. The
 * send path (`resolvePillsToPromptActionsAtom`) keeps its own checks as a
 * backstop.
 *
 * Deliberately conservative: blocking a message that would have worked is
 * worse than letting one through that the backstop or the model handles, so a
 * requirement only blocks when nothing in the message could satisfy it.
 *
 * Pure and Zotero-free; `actionRequirementBlockAtom` gathers the inputs.
 */

import type { Action } from '@beaver/agent-core/types/actions';
import { splitContentByCommandTokens, type SlashCommandDescriptor } from '@beaver/agent-ui/composer/slashCommands';

/** Why Send is blocked. */
export interface ActionRequirementBlock {
    /** The one-line hint shown under the input, or null when the composer
     *  already says what is missing (the /command's placeholder). */
    hint: string | null;
}

/** Lead-in for an action that requires an argument but names no hint of its own. */
export const DEFAULT_ARGUMENT_REQUIRED_HINT = 'Say what you want';

export interface ActionRequirementInput {
    /** The composer's plain text, pill tokens included. */
    content: string;
    /** The /command pills in the message, in document order. */
    pills: SlashCommandDescriptor[];
    /** Current action definitions, to read each pill's requirements. */
    actions: (Pick<Action, 'id' | 'argumentRequired' | 'argumentRequiredHint'> & { text?: string })[];
    /** A collection, saved search or view in a searchable library is attached
     *  (the condition the send path requires of a collection action). */
    hasCollectionTarget: boolean;
    /** Something a document action can run on reaches the model with this
     *  message: attached items or files, or the attachment open in the reader. */
    hasDocumentContext: boolean;
    /** Anything else that gives an item action something to work on: an open
     *  note or a library, collection or tag scope. */
    hasOtherItemContext: boolean;
}

/** Whether the message holds text other than its /command tokens. */
export function hasTextBesidesPills(content: string, pills: SlashCommandDescriptor[]): boolean {
    return splitContentByCommandTokens(content, pills, pill => pill.commandName)
        .some(segment => !segment.match && segment.text.trim().length > 0);
}

/**
 * Whether the composer shows this pill's argument hint as ghost text right
 * after it. Mirrors the editor's rule: the hint belongs to the last pill and
 * shows only while nothing but spaces follows it on the last line, so a later
 * pill, a line break or a new paragraph hides it. Only called when the
 * message holds no text besides its pills.
 */
export function isArgumentHintVisible(content: string, pills: SlashCommandDescriptor[], pill: SlashCommandDescriptor): boolean {
    if (!pill.argumentHint?.trim()) return false;
    const segments = splitContentByCommandTokens(content, pills, candidate => candidate.commandName);
    let last = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].match) {
            last = i;
            break;
        }
    }
    if (last < 0 || segments[last].match?.commandName !== pill.commandName) return false;
    return segments.slice(last + 1).every(segment => !/[\r\n]/.test(segment.text));
}

/**
 * The first unmet requirement among the message's pills, in document order, or
 * null when the message can be sent as far as its actions are concerned.
 *
 * Checked per pill:
 * - its resolved target type: a collection action needs a collection target;
 *   an item action needs items, a collection or another item scope; a document
 *   action needs a document (or a collection, which a document action may also
 *   be pointed at). `global`, `note` and an unresolved target are not checked.
 * - `argumentRequired`: the message must hold text besides the pills. No hint
 *   while the composer shows the pill's argument hint right after it, which
 *   already asks for the text (see `isArgumentHintVisible`).
 *
 * Pills whose action no longer exists are skipped, matching the send path,
 * which sends them without a prompt.
 */
export function getActionRequirementBlock(input: ActionRequirementInput): ActionRequirementBlock | null {
    const { content, pills, actions, hasCollectionTarget, hasDocumentContext, hasOtherItemContext } = input;
    if (pills.length === 0) return null;
    let hasText: boolean | null = null;

    for (const pill of pills) {
        if (pill.missing) continue;
        const action = actions.find(a => a.id === pill.actionId);
        if (!action) continue;
        const command = `/${pill.commandName}`;
        // A prompt with {{variables}} resolves its items from the live Zotero
        // context at send time, which this check cannot see.
        const resolvesAtSend = !!action.text?.includes('{{');

        switch (resolvesAtSend ? undefined : pill.targetType) {
            case 'collection':
                if (!hasCollectionTarget) {
                    return { hint: `Attach a collection to run ${command}` };
                }
                break;
            case 'items':
                if (!hasDocumentContext && !hasCollectionTarget && !hasOtherItemContext) {
                    return { hint: `Attach papers or a collection to run ${command}` };
                }
                break;
            case 'attachment':
                if (!hasDocumentContext && !hasCollectionTarget) {
                    return { hint: `Attach or open a PDF to run ${command}` };
                }
                break;
            default:
                break;
        }

        if (action.argumentRequired) {
            if (hasText === null) hasText = hasTextBesidesPills(content, pills);
            if (!hasText) {
                if (isArgumentHintVisible(content, pills, pill)) return { hint: null };
                const leadIn = action.argumentRequiredHint?.trim() || DEFAULT_ARGUMENT_REQUIRED_HINT;
                return { hint: `${leadIn} after ${command}` };
            }
        }
    }
    return null;
}
