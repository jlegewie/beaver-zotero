/**
 * Whether the user's next message can use Plus Tools, and if not, why.
 *
 * Plus Tools are the features that run on Beaver credits whatever model the
 * user chose: research tables, external search, batch jobs, AI ranking. A run
 * gets them on the Beaver model, or on the user's own model (API key or custom
 * model) with the Plus Tools preference on, and in both cases only while the
 * account has credits. The backend decides per run; this mirrors its rule so a
 * surface can say what is missing before the user writes a message.
 *
 * Pure: `plusToolsAccessAtom` (`react/atoms/chatAccess.ts`) gathers the inputs.
 */

import type { ChatAccessGate } from '../atoms/chatAccess';

/** Which model the chat input runs on. */
export type PlusToolsModel = 'beaver' | 'own';

export type PlusToolsAccess =
    /** The next message gets Plus Tools. */
    | { status: 'ready'; model: PlusToolsModel }
    /** No credits left. On the Beaver model nothing runs; on the user's own
     *  model the message runs without Plus Tools. `plusToolsOn` is the
     *  preference, which matters only on the user's own model. */
    | { status: 'no-credits'; model: PlusToolsModel; plusToolsOn: boolean }
    /** The user's own model with the Plus Tools preference off, and credits
     *  to spend: turning the preference on (or choosing the Beaver model) is
     *  all that is missing. */
    | { status: 'plus-tools-off'; model: 'own' }
    | { status: 'signed-out' }
    /** Signing in is being restored, the profile is loading, or the account
     *  needs a screen first (onboarding, update, downgrade notice). Beaver
     *  shows that screen when it opens. */
    | { status: 'not-ready'; gate: Exclude<ChatAccessGate, 'signed-out'> };

export interface PlusToolsAccessInput {
    /** `chatAccessGateAtom`: what stands between the user and a chat. */
    gate: ChatAccessGate | null;
    /** The chat input's model is billed to Beaver credits (`isUsingBeaverCreditsAtom`). */
    usesBeaverModel: boolean;
    /** The "Use Plus Tools with your API key" preference. */
    plusToolsPref: boolean;
    /** Spendable Beaver credits (`remainingBeaverCreditsAtom`). */
    credits: number;
}

export function getPlusToolsAccess(input: PlusToolsAccessInput): PlusToolsAccess {
    const { gate, usesBeaverModel, plusToolsPref, credits } = input;
    if (gate === 'signed-out') return { status: 'signed-out' };
    if (gate) return { status: 'not-ready', gate };

    const model: PlusToolsModel = usesBeaverModel ? 'beaver' : 'own';
    if (credits <= 0) return { status: 'no-credits', model, plusToolsOn: plusToolsPref };
    if (model === 'own' && !plusToolsPref) return { status: 'plus-tools-off', model };
    return { status: 'ready', model };
}
