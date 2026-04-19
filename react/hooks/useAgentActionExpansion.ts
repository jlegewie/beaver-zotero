/**
 * `useAgentActionExpansion` — shared expansion-state hook for agent-action
 * views. Replaces the ~30-line duplicated `useEffect` + ref bookkeeping in
 * `AgentActionView.tsx` and `EditNoteGroupView.tsx`.
 *
 * The pure helpers below (`computeExpansionWrite`, `computeVisibleExpansion`)
 * encode all of the combinatoric branching and are unit-testable without
 * React; the hook is a thin wrapper over them.
 *
 * Key invariant: the initial-default computation and the transition trigger
 * are separate. `initialExpanded` only influences the first write;
 * subsequent writes fire only on `autoExpandWhen` transitions. Later
 * changes to `initialExpanded` do NOT re-trigger auto-expansion.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { toolExpandedAtom, setToolExpandedAtom } from '../atoms/messageUIState';

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

// ---------------------------------------------------------------------------
// Hook wrapper
// ---------------------------------------------------------------------------

export interface UseAgentActionExpansionParams {
    /** Per-tool expansion key, e.g. `${runId}:${responseIndex}:${toolcallId}`. */
    expansionKey: string;
    /**
     * Transition trigger. When this boolean changes between renders, the
     * hook writes a new expansion value to the atom. Other param changes
     * do NOT trigger writes.
     */
    autoExpandWhen: boolean;
    /**
     * Initial expansion value written on first render when no persisted
     * atom entry exists. Falls back to `autoExpandWhen` when omitted.
     * Changes after first render are ignored.
     */
    initialExpanded?: boolean;
    /** When true, every write resolves to `true`. */
    forceExpandedWhen?: boolean;
    /**
     * Compute-time override: forces `isExpanded=false` in the returned value
     * regardless of stored atom state. Also gates `toggleExpanded()` so
     * user-driven toggles are suppressed while this is true. Does NOT gate
     * `setExpanded(bool)` — programmatic writes (e.g. undo-error auto-
     * expansion) still land in the atom; they just remain invisible until
     * the gate drops.
     */
    forceCollapsedWhen?: boolean;
}

export interface UseAgentActionExpansionResult {
    isExpanded: boolean;
    setExpanded: (expanded: boolean) => void;
    toggleExpanded: () => void;
}

export function useAgentActionExpansion(
    params: UseAgentActionExpansionParams,
): UseAgentActionExpansionResult {
    const {
        expansionKey,
        autoExpandWhen,
        initialExpanded,
        forceExpandedWhen = false,
        forceCollapsedWhen = false,
    } = params;

    const expansionState = useAtomValue(toolExpandedAtom);
    const writeExpanded = useSetAtom(setToolExpandedAtom);
    const atomValue = expansionState[expansionKey];

    const hasInitializedRef = useRef(false);
    const prevAutoExpandWhenRef = useRef(autoExpandWhen);

    useEffect(() => {
        const isFirstInit = !hasInitializedRef.current;
        const { shouldWrite, value } = computeExpansionWrite({
            isFirstInit,
            hasExistingState: atomValue !== undefined,
            autoExpandWhen,
            prevAutoExpandWhen: prevAutoExpandWhenRef.current,
            initialExpanded,
            forceExpandedWhen,
        });

        if (shouldWrite) {
            writeExpanded({ key: expansionKey, expanded: value });
        }

        hasInitializedRef.current = true;
        prevAutoExpandWhenRef.current = autoExpandWhen;
        // `initialExpanded` and `forceExpandedWhen` are deliberately NOT in
        // the dep array: the effect must fire on `autoExpandWhen` transitions
        // only, never on initialExpanded changes (that would break the
        // error-only-initial-expand contract in EditNoteGroupView).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expansionKey, autoExpandWhen, atomValue, writeExpanded]);

    const isExpanded = computeVisibleExpansion({
        atomValue,
        autoExpandWhen,
        initialExpanded,
        forceExpandedWhen,
        forceCollapsedWhen,
    });

    // setExpanded is intentionally unconditional — see forceCollapsedWhen
    // doc above. Do NOT "fix" this by gating on forceCollapsedWhen.
    const setExpanded = useCallback(
        (expanded: boolean) => {
            writeExpanded({ key: expansionKey, expanded });
        },
        [expansionKey, writeExpanded],
    );

    // toggleExpanded IS gated — the streaming/force-collapsed state should
    // suppress user-driven toggles, mirroring the `disabled={hasStreamingChild}`
    // guards the hook replaces.
    const toggleExpanded = useCallback(() => {
        if (forceCollapsedWhen) return;
        const current = atomValue ?? (forceExpandedWhen || (initialExpanded ?? autoExpandWhen));
        writeExpanded({ key: expansionKey, expanded: !current });
    }, [forceCollapsedWhen, atomValue, forceExpandedWhen, initialExpanded, autoExpandWhen, expansionKey, writeExpanded]);

    return { isExpanded, setExpanded, toggleExpanded };
}
