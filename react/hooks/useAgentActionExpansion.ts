/**
 * Pure helpers for the (forthcoming) `useAgentActionExpansion` hook.
 *
 * The hook wrapper is deliberately not included in this file yet — the two
 * helpers below encode all of the combinatoric branching for the expansion
 * state machine and are unit-testable without React. Once the hook wrapper
 * is added it will live alongside these helpers and delegate to them.
 *
 * See the step 2 plan for the contract; the key invariant is that the
 * initial-default computation and the transition trigger are separate:
 * `initialExpanded` (and `hasExistingState`) only influence the first write,
 * while later writes fire only on `autoExpandWhen` transitions.
 */

export interface ComputeExpansionWriteInput {
    /** True on the first effect run after mount. */
    isFirstInit: boolean;
    /** True when the expansion atom already has an entry for this key. */
    hasExistingState: boolean;
    /** Current value of the transition trigger. */
    autoExpandWhen: boolean;
    /** Previous render's `autoExpandWhen` value, tracked by the hook via a ref. */
    prevAutoExpandWhen: boolean;
    /** Optional initial-default override; used only on first init. */
    initialExpanded: boolean | undefined;
    /** When true, every write resolves to `true`. */
    forceExpandedWhen: boolean;
}

export interface ExpansionWriteResult {
    shouldWrite: boolean;
    /** Defined only when `shouldWrite` is true; otherwise `false` as a placeholder. */
    value: boolean;
}

/**
 * Decide whether the hook's `useEffect` should write a new expansion value,
 * and what that value is. Returns `{ shouldWrite: false, value: false }`
 * when no write should happen.
 */
export function computeExpansionWrite(input: ComputeExpansionWriteInput): ExpansionWriteResult {
    const {
        isFirstInit,
        hasExistingState,
        autoExpandWhen,
        prevAutoExpandWhen,
        initialExpanded,
        forceExpandedWhen,
    } = input;

    if (isFirstInit) {
        if (hasExistingState) {
            return { shouldWrite: false, value: false };
        }
        const value = forceExpandedWhen ? true : (initialExpanded ?? autoExpandWhen);
        return { shouldWrite: true, value };
    }

    if (prevAutoExpandWhen === autoExpandWhen) {
        return { shouldWrite: false, value: false };
    }

    const value = forceExpandedWhen ? true : autoExpandWhen;
    return { shouldWrite: true, value };
}

export interface ComputeVisibleExpansionInput {
    /** Current value in `toolExpandedAtom`, or undefined if no entry. */
    atomValue: boolean | undefined;
    autoExpandWhen: boolean;
    initialExpanded: boolean | undefined;
    forceExpandedWhen: boolean;
    forceCollapsedWhen: boolean;
}

/**
 * Compute the `isExpanded` value returned to the caller. `forceCollapsedWhen`
 * overrides the atom value without mutating it — useful as a compute-time gate
 * for states like "currently streaming" that should not persist expansion.
 */
export function computeVisibleExpansion(input: ComputeVisibleExpansionInput): boolean {
    const {
        atomValue,
        autoExpandWhen,
        initialExpanded,
        forceExpandedWhen,
        forceCollapsedWhen,
    } = input;

    if (forceCollapsedWhen) return false;
    if (atomValue !== undefined) return atomValue;
    return forceExpandedWhen || (initialExpanded ?? autoExpandWhen);
}
