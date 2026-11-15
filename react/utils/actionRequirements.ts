/**
 * Required input for the /command pills in the composer.
 *
 * A built-in action marked `argumentRequired` needs the user to say what they
 * want after its /command. While the message holds nothing but its pills, Send
 * stays disabled and its tooltip says what is missing; the pill's own argument
 * hint (the ghost text after it) usually says so already.
 *
 * Pure and Zotero-free; `actionRequirementBlockAtom` gathers the inputs.
 */

import type { Action } from '@beaver/agent-core/types/actions';
import { splitContentByCommandTokens, type SlashCommandDescriptor } from '@beaver/agent-ui/composer/slashCommands';

/** Why Send is blocked. */
export interface ActionRequirementBlock {
    /** What the user still has to do, for the Send button's tooltip. */
    hint: string;
}

/** Lead-in for an action that requires an argument but names no hint of its own. */
export const DEFAULT_ARGUMENT_REQUIRED_HINT = 'Say what you want';

export interface ActionRequirementInput {
    /** The composer's plain text, pill tokens included. */
    content: string;
    /** The /command pills in the message, in document order. */
    pills: SlashCommandDescriptor[];
    /** Current action definitions, to read each pill's requirement. */
    actions: Pick<Action, 'id' | 'argumentRequired' | 'argumentRequiredHint'>[];
}

/** Whether the message holds text other than its /command tokens. */
export function hasTextBesidesPills(content: string, pills: SlashCommandDescriptor[]): boolean {
    return splitContentByCommandTokens(content, pills, pill => pill.commandName)
        .some(segment => !segment.match && segment.text.trim().length > 0);
}

/**
 * The first pill, in document order, whose action requires an argument the
 * message does not hold, or null when the message can be sent. Any text
 * besides the pills counts as the argument. Pills whose action no longer
 * exists are skipped, matching the send path, which sends them without a
 * prompt.
 */
export function getActionRequirementBlock(input: ActionRequirementInput): ActionRequirementBlock | null {
    const { content, pills, actions } = input;
    for (const pill of pills) {
        if (pill.missing) continue;
        const action = actions.find(a => a.id === pill.actionId);
        if (!action?.argumentRequired) continue;
        if (hasTextBesidesPills(content, pills)) return null;
        const leadIn = action.argumentRequiredHint?.trim() || DEFAULT_ARGUMENT_REQUIRED_HINT;
        return { hint: `${leadIn} after /${pill.commandName}` };
    }
    return null;
}
