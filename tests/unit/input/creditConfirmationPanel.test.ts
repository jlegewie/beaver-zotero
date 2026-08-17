/**
 * The run-level credit confirmation card.
 *
 * Two contracts matter here. The card is a mouthpiece for the backend: the
 * title, message, detail lines and button labels are rendered verbatim and no
 * prose is derived from the numeric fields, which travel for logging only.
 * And exactly one decision may leave the client, because the backend stops
 * listening on the confirmation id as soon as it has an answer.
 *
 * The card is exercised as a plain function rather than mounted: it is
 * deliberately hook-free, and this repo's jsdom environment does not currently
 * load, so there is no DOM to render into.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));

// The panel's only tie to the transport. Replacing it here keeps this test off
// the WebSocket/Supabase module graph while leaving the real pending-state
// atoms in place, so "the card is retired" is still a real assertion.
vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai/vanilla');
    const { removePendingCreditConfirmationAtom } = await import(
        '@beaver/agent-core/run-state/pendingCreditConfirmations'
    );
    return {
        closeWSConnectionAtom: atom(null, () => {}),
        sendCreditConfirmationResponseAtom: atom(
            null,
            (_get: unknown, set: any, decision: { confirmationId: string; approved: boolean }) => {
                sendSpy(decision);
                set(removePendingCreditConfirmationAtom, decision.confirmationId);
            },
        ),
    };
});

import { createStore } from 'jotai';
import type { PendingCreditConfirmation } from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import {
    addPendingCreditConfirmationAtom,
    pendingCreditConfirmationsAtom,
} from '@beaver/agent-core/run-state/pendingCreditConfirmations';
import type { WSCreditConfirmationRequest } from '@beaver/agent-core/protocol/agentProtocol';
import {
    CreditConfirmationCard,
    createCreditDecisionHandlers,
} from '../../../react/components/input/CreditConfirmationPanel';
import { sendCreditConfirmationResponseAtom } from '../../../react/atoms/agentRunAtoms';

// Deliberately digit-free copy, so any digit in the rendered output can only
// have come from the numeric fields below.
const TITLE = 'Continue past your credit limit?';
const MESSAGE = 'This request is about to go over your limit. Wrapping up stops any further charges.';
const DETAILS = ['Very large context — one credit', 'Extract from attachments — some credits', 'Deep search of external sources — one credit'];
const FOOTER = 'Continuing may add further charges without asking again.';
const APPROVE_LABEL = 'Continue';
const DECLINE_LABEL = 'Wrap up now';

function confirmation(overrides: Partial<PendingCreditConfirmation> = {}): PendingCreditConfirmation {
    return {
        confirmationId: 'conf-1',
        runId: 'run-1',
        threadId: 'thread-1',
        title: TITLE,
        message: MESSAGE,
        details: [...DETAILS],
        footer: FOOTER,
        approveLabel: APPROVE_LABEL,
        declineLabel: DECLINE_LABEL,
        pendingCredits: 12,
        projectedTotalCredits: 37,
        threshold: 5,
        timeoutSeconds: 300,
        ...overrides,
    };
}

function confirmationEvent(): WSCreditConfirmationRequest {
    const pending = confirmation();
    return {
        event: 'credit_confirmation_request',
        confirmation_id: pending.confirmationId,
        run_id: pending.runId,
        thread_id: pending.threadId,
        title: pending.title,
        message: pending.message,
        details: pending.details,
        footer: pending.footer,
        approve_label: pending.approveLabel,
        decline_label: pending.declineLabel,
        pending_credits: pending.pendingCredits,
        projected_total_credits: pending.projectedTotalCredits,
        threshold: pending.threshold,
        timeout_seconds: pending.timeoutSeconds,
    };
}

interface Clickable {
    text: string;
    onClick: () => void;
    disabled: boolean;
}

/** All text the card renders, in order, with a space between nodes. */
function collectText(node: React.ReactNode): string {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(collectText).join(' ');
    if (React.isValidElement(node)) {
        return collectText((node.props as { children?: React.ReactNode }).children);
    }
    return '';
}

/** The first element in the tree with this ARIA role, if any. */
function findByRole(node: React.ReactNode, role: string): React.ReactNode | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findByRole(child, role);
            if (found) return found;
        }
        return null;
    }
    if (!React.isValidElement(node)) return null;
    const props = node.props as { role?: string; children?: React.ReactNode };
    if (props.role === role) return node;
    return findByRole(props.children ?? null, role);
}

/** Every element in the tree that carries an onClick handler. */
function collectClickables(node: React.ReactNode, found: Clickable[] = []): Clickable[] {
    if (Array.isArray(node)) {
        node.forEach((child) => collectClickables(child, found));
        return found;
    }
    if (!React.isValidElement(node)) return found;

    const props = node.props as {
        children?: React.ReactNode;
        onClick?: () => void;
        disabled?: boolean;
        ariaLabel?: string;
    };
    if (typeof props.onClick === 'function') {
        found.push({
            text: collectText(props.children).replace(/\s+/g, ' ').trim(),
            onClick: props.onClick,
            disabled: props.disabled === true,
        });
    }
    collectClickables(props.children, found);
    return found;
}

function renderCard(overrides: Partial<PendingCreditConfirmation> = {}, disabled = false) {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    const onStop = vi.fn();
    const tree = CreditConfirmationCard({
        confirmation: confirmation(overrides),
        disabled,
        onApprove,
        onDecline,
        onStop,
    });
    return { tree, onApprove, onDecline, onStop, clickables: collectClickables(tree) };
}

describe('CreditConfirmationCard', () => {
    it('renders the backend copy verbatim', () => {
        const text = collectText(renderCard().tree);

        expect(text).toContain(TITLE);
        expect(text).toContain(MESSAGE);
        for (const detail of DETAILS) {
            expect(text).toContain(detail);
        }
        expect(text).toContain(FOOTER);
        expect(text).toContain(APPROVE_LABEL);
        expect(text).toContain(DECLINE_LABEL);
    });

    it('renders the footer apart from the charge lines', () => {
        // The footer says what the decision means; the details are the charges
        // it qualifies. A backend that sends no footer must not leave a gap.
        const { tree } = renderCard();
        const listed = collectText(
            findByRole(tree, 'list') as React.ReactNode,
        );

        expect(listed).not.toContain(FOOTER);
        expect(collectText(tree)).toContain(FOOTER);
        expect(collectText(renderCard({ footer: undefined }).tree)).not.toContain(FOOTER);
    });

    it('writes no prose of its own from the numeric fields', () => {
        // pendingCredits / projectedTotalCredits / threshold are for logging;
        // the wording of the decision belongs to the backend that asked.
        const text = collectText(renderCard().tree);

        expect(text).not.toMatch(/\d/);
    });

    it('omits the detail list when the backend sent no lines', () => {
        const text = collectText(renderCard({ details: [] }).tree);

        expect(text).toContain(MESSAGE);
        expect(text).not.toContain(DETAILS[0]);
    });

    it('wires the approve and decline buttons to their own labels', () => {
        const { onApprove, onDecline, clickables } = renderCard();

        const approve = clickables.find((c) => c.text.startsWith(APPROVE_LABEL));
        const decline = clickables.find((c) => c.text === DECLINE_LABEL);
        expect(approve).toBeDefined();
        expect(decline).toBeDefined();

        approve!.onClick();
        expect(onApprove).toHaveBeenCalledTimes(1);
        expect(onDecline).not.toHaveBeenCalled();

        decline!.onClick();
        expect(onDecline).toHaveBeenCalledTimes(1);
    });

    it('disables both decision buttons once a decision has been made', () => {
        const { clickables } = renderCard({}, true);

        expect(clickables.find((c) => c.text.startsWith(APPROVE_LABEL))?.disabled).toBe(true);
        expect(clickables.find((c) => c.text === DECLINE_LABEL)?.disabled).toBe(true);
        // Stop stays live: cancelling the run is still available.
        expect(clickables.find((c) => c.text === 'Stop')?.disabled).toBe(false);
    });
});

describe('createCreditDecisionHandlers', () => {
    beforeEach(() => {
        sendSpy.mockClear();
    });

    function harness() {
        const store = createStore();
        store.set(addPendingCreditConfirmationAtom, confirmationEvent());
        const onDecided = vi.fn();
        const handlers = createCreditDecisionHandlers(
            'conf-1',
            (decision) => store.set(sendCreditConfirmationResponseAtom, decision),
            onDecided,
        );
        return { store, handlers, onDecided };
    }

    it('approving sends one approval and retires the card', () => {
        const { store, handlers, onDecided } = harness();

        handlers.approve();

        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledWith({ confirmationId: 'conf-1', approved: true });
        expect(onDecided).toHaveBeenCalledTimes(1);
        expect(store.get(pendingCreditConfirmationsAtom).has('conf-1')).toBe(false);
    });

    it('declining sends one decline and retires the card', () => {
        const { store, handlers } = harness();

        handlers.decline();

        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledWith({ confirmationId: 'conf-1', approved: false });
        expect(store.get(pendingCreditConfirmationsAtom).has('conf-1')).toBe(false);
    });

    it('a double click on approve sends only one response', () => {
        // The panel is still mounted in the instant after the first send, so a
        // second click can reach the handler; only one may reach the backend.
        const { handlers } = harness();

        handlers.approve();
        handlers.approve();

        expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it('a decision after the first is ignored, whichever way it goes', () => {
        const { handlers } = harness();

        handlers.approve();
        handlers.decline();

        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledWith({ confirmationId: 'conf-1', approved: true });
    });
});

describe('CreditConfirmationCard keyboard safety', () => {
    it('answers only on click, never on a keypress', () => {
        // Spending credits has to be deliberate. A shortcut on the card would
        // let a keypress meant for the composer answer it, and would answer it
        // the same way no matter which button the user had focused.
        const { tree } = renderCard();
        const root = tree as React.ReactElement<{
            onKeyDown?: unknown;
            tabIndex?: number;
        }>;

        expect(root.props.onKeyDown).toBeUndefined();
        expect(root.props.tabIndex).toBeUndefined();
    });
});
