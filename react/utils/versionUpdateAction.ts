/**
 * What the primary button of a floating release card does for this user.
 *
 * A release's action is written once, for a user who can use the feature. This
 * adapts it to the account: signed out, not set up yet, or (for a feature that
 * needs Plus Tools) on their own model with Plus Tools off or out of credits.
 * The card never offers a button that would lead to a message that cannot run.
 * An action that a feature-credit task teaches opens that task's setup card
 * while the account can still earn it, and the card says what it earns.
 */

import type { VersionUpdateAction } from '../constants/versionUpdateMessages';
import type { PlusToolsAccess } from './plusToolsAccess';

/** The configured action, kept as is when the account can take it. */
export type ResolvedVersionAction =
    | Exclude<VersionUpdateAction, { type: 'stage-action' }>
    /** Open Beaver with the action's /command staged in the chat input, after
     *  turning the Plus Tools preference on when `enablePlusTools`. */
    | { type: 'stage-action'; label: string; actionId: string; enablePlusTools: boolean; note?: string }
    | { type: 'get-credits'; label: string; note: string }
    /** Open Beaver on a new chat with the setup card of this feature-credit task. */
    | { type: 'feature-task'; label: string; key: string; note: string };

const DEFAULT_ACTION: VersionUpdateAction = { type: 'open-beaver', label: 'Open Beaver' };

export const PLUS_TOOLS_OFF_NOTE = 'With your own API key, this needs Plus Tools, which use your Beaver credits.';
export const NO_CREDITS_NOTE = 'This uses Beaver credits, and you have none left.';
export const FEATURE_TASK_LABEL = 'Try it for free';

export function resolveVersionUpdateAction(
    action: VersionUpdateAction | undefined,
    access: PlusToolsAccess,
    /** The feature-credit tasks the account can still earn and start: key to credits. */
    earnableFeatureTasks: ReadonlyMap<string, number> = new Map(),
): ResolvedVersionAction {
    const configured = action ?? DEFAULT_ACTION;
    if (configured.type === 'open-url' || configured.type === 'open-beaver') return configured;

    // The quick prompt and a staged action both need a chat. Without one,
    // open Beaver, which shows the screen that resolves it (sign-in,
    // onboarding, ...).
    if (access.status === 'signed-out') return { type: 'open-beaver', label: 'Sign in to try' };
    if (access.status === 'not-ready') return { type: 'open-beaver', label: 'Open Beaver' };

    if (configured.type === 'quick-prompt') return configured;

    // The server grants a task's credits before the run's credit check, and
    // its setup card says what else the task needs (the Beaver model for
    // tables), so this comes before the Plus Tools and credit checks.
    const credits = configured.featureTask ? earnableFeatureTasks.get(configured.featureTask) : undefined;
    if (configured.featureTask && credits !== undefined) {
        const note = `Trying it earns ${credits} free credits.`;
        return { type: 'feature-task', label: FEATURE_TASK_LABEL, key: configured.featureTask, note };
    }

    const staged = { type: 'stage-action', actionId: configured.actionId } as const;
    if (!configured.requiresPlusTools || access.status === 'ready') {
        return { ...staged, label: configured.label, enablePlusTools: false };
    }
    if (access.status === 'plus-tools-off') {
        return { ...staged, label: 'Turn on Plus Tools', enablePlusTools: true, note: PLUS_TOOLS_OFF_NOTE };
    }
    return { type: 'get-credits', label: 'Get credits', note: NO_CREDITS_NOTE };
}
