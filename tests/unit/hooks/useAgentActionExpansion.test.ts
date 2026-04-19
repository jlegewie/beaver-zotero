/**
 * Pure-function unit tests for the `useAgentActionExpansion` helpers.
 *
 * Covers the initial-vs-transition separation that is the whole reason the
 * hook exists: only `autoExpandWhen` transitions should produce later
 * writes; changes to `initialExpanded` (e.g. the error-only clause in
 * EditNoteGroupView) must NOT spontaneously expand or collapse after mount.
 */

import { describe, it, expect } from 'vitest';
import {
    computeExpansionWrite,
    computeVisibleExpansion,
    type ComputeExpansionWriteInput,
    type ComputeVisibleExpansionInput,
} from '../../../react/hooks/useAgentActionExpansion';

function writeInput(overrides: Partial<ComputeExpansionWriteInput> = {}): ComputeExpansionWriteInput {
    return {
        isFirstInit: true,
        hasExistingState: false,
        autoExpandWhen: false,
        prevAutoExpandWhen: false,
        initialExpanded: undefined,
        forceExpandedWhen: false,
        ...overrides,
    };
}

function visibleInput(overrides: Partial<ComputeVisibleExpansionInput> = {}): ComputeVisibleExpansionInput {
    return {
        atomValue: undefined,
        autoExpandWhen: false,
        initialExpanded: undefined,
        forceExpandedWhen: false,
        forceCollapsedWhen: false,
        ...overrides,
    };
}

describe('computeExpansionWrite', () => {
    it('case 1: first init with no existing state writes `autoExpandWhen` when `initialExpanded` is undefined', () => {
        expect(computeExpansionWrite(writeInput({
            isFirstInit: true,
            hasExistingState: false,
            autoExpandWhen: false,
        }))).toEqual({ shouldWrite: true, value: false });

        expect(computeExpansionWrite(writeInput({
            isFirstInit: true,
            hasExistingState: false,
            autoExpandWhen: true,
        }))).toEqual({ shouldWrite: true, value: true });
    });

    it('case 2: first init prefers `initialExpanded` over `autoExpandWhen` (covers EditNoteGroupView error-only initial-expand)', () => {
        expect(computeExpansionWrite(writeInput({
            isFirstInit: true,
            hasExistingState: false,
            autoExpandWhen: false,
            initialExpanded: true,
        }))).toEqual({ shouldWrite: true, value: true });

        expect(computeExpansionWrite(writeInput({
            isFirstInit: true,
            hasExistingState: false,
            autoExpandWhen: true,
            initialExpanded: false,
        }))).toEqual({ shouldWrite: true, value: false });
    });

    it('case 3: first init skips the write when atom already has an entry', () => {
        const result = computeExpansionWrite(writeInput({
            isFirstInit: true,
            hasExistingState: true,
            autoExpandWhen: true,
            initialExpanded: true,
            forceExpandedWhen: true,
        }));
        expect(result.shouldWrite).toBe(false);
    });

    it('case 4: later rerender with autoExpandWhen flipped false→true writes true', () => {
        expect(computeExpansionWrite(writeInput({
            isFirstInit: false,
            hasExistingState: true,
            autoExpandWhen: true,
            prevAutoExpandWhen: false,
        }))).toEqual({ shouldWrite: true, value: true });
    });

    it('case 4 (mirror): later rerender with autoExpandWhen flipped true→false writes false', () => {
        expect(computeExpansionWrite(writeInput({
            isFirstInit: false,
            hasExistingState: true,
            autoExpandWhen: false,
            prevAutoExpandWhen: true,
        }))).toEqual({ shouldWrite: true, value: false });
    });

    it('case 5: later rerender with unchanged `autoExpandWhen` does NOT write, even when `initialExpanded` changes (regression guard for error-only clause)', () => {
        // `autoExpandWhen` stays false; only `initialExpanded` flipped undefined→true.
        // This is the exact scenario the reviewer flagged: a group that has already
        // mounted and enters an error-only state must NOT auto-expand on a later tick.
        const result = computeExpansionWrite(writeInput({
            isFirstInit: false,
            hasExistingState: true,
            autoExpandWhen: false,
            prevAutoExpandWhen: false,
            initialExpanded: true,
        }));
        expect(result.shouldWrite).toBe(false);

        const result2 = computeExpansionWrite(writeInput({
            isFirstInit: false,
            hasExistingState: true,
            autoExpandWhen: true,
            prevAutoExpandWhen: true,
            initialExpanded: false,
        }));
        expect(result2.shouldWrite).toBe(false);
    });

    it('case 6a: forceExpandedWhen=true writes true on first init even when autoExpandWhen=false and initialExpanded=false', () => {
        expect(computeExpansionWrite(writeInput({
            isFirstInit: true,
            hasExistingState: false,
            autoExpandWhen: false,
            initialExpanded: false,
            forceExpandedWhen: true,
        }))).toEqual({ shouldWrite: true, value: true });
    });

    it('case 6b: forceExpandedWhen=true writes true on every transition regardless of autoExpandWhen', () => {
        expect(computeExpansionWrite(writeInput({
            isFirstInit: false,
            hasExistingState: true,
            autoExpandWhen: false,
            prevAutoExpandWhen: true,
            forceExpandedWhen: true,
        }))).toEqual({ shouldWrite: true, value: true });
    });
});

describe('computeVisibleExpansion', () => {
    it('case 7: atom undefined falls back to `autoExpandWhen` when no force flags are set', () => {
        expect(computeVisibleExpansion(visibleInput({
            atomValue: undefined,
            autoExpandWhen: true,
        }))).toBe(true);

        expect(computeVisibleExpansion(visibleInput({
            atomValue: undefined,
            autoExpandWhen: false,
        }))).toBe(false);
    });

    it('case 8: forceCollapsedWhen=true returns false even when atom stores true (atom not mutated at this layer)', () => {
        expect(computeVisibleExpansion(visibleInput({
            atomValue: true,
            autoExpandWhen: true,
            initialExpanded: true,
            forceExpandedWhen: true,
            forceCollapsedWhen: true,
        }))).toBe(false);
    });

    it('case 9: atom undefined + forceExpandedWhen=true returns true regardless of autoExpandWhen', () => {
        expect(computeVisibleExpansion(visibleInput({
            atomValue: undefined,
            autoExpandWhen: false,
            initialExpanded: undefined,
            forceExpandedWhen: true,
            forceCollapsedWhen: false,
        }))).toBe(true);
    });

    it('atom value takes precedence over fallback when not collapsed', () => {
        expect(computeVisibleExpansion(visibleInput({
            atomValue: false,
            autoExpandWhen: true,
            initialExpanded: true,
            forceExpandedWhen: true,
        }))).toBe(false);

        expect(computeVisibleExpansion(visibleInput({
            atomValue: true,
            autoExpandWhen: false,
            initialExpanded: false,
            forceExpandedWhen: false,
        }))).toBe(true);
    });

    it('initialExpanded is used as the fallback when the atom is undefined', () => {
        expect(computeVisibleExpansion(visibleInput({
            atomValue: undefined,
            autoExpandWhen: false,
            initialExpanded: true,
        }))).toBe(true);
    });
});
