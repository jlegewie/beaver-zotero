/**
 * What the batch outcome blocks say about the rows they do not list.
 *
 * Every block caps its rows, so each must report what it hid — a truncated list
 * with no count reads as a complete one. Hook-free components, so they are
 * called directly.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { BatchProgressEntry } from '@beaver/agent-core/run-state/batchProgress';
import {
    BatchFailureReasonBlock,
    BatchRemovalBlock,
    BatchTallyBlock,
} from '@beaver/agent-ui/chat/BatchOutcomeBlocks';

function entry(overrides: Partial<BatchProgressEntry> = {}): BatchProgressEntry {
    return {
        batch_id: 'b1',
        operation: 'sort',
        progress_primary: '40 of 184',
        show_progress: true,
        ...overrides,
    };
}

function renderedText(node: React.ReactNode, out: string[] = []): string[] {
    if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach((child) => renderedText(child, out));
        return out;
    }
    if (!React.isValidElement(node)) return out;
    renderedText((node as React.ReactElement<any>).props.children ?? null, out);
    return out;
}

const text = (node: React.ReactNode) => renderedText(node).join(' ');

describe('BatchTallyBlock', () => {
    it('reports the destination rows it hid', () => {
        const node = BatchTallyBlock({
            batch: entry({
                tally_heading: 'Where items are going',
                tallies: [{ label: 'Ecology', count: 4 }],
                tallies_overflow: 7,
            }),
        });
        expect(text(node)).toContain('+ 7 more');
    });
});

describe('BatchRemovalBlock', () => {
    it('reports the removal rows it hid', () => {
        const node = BatchRemovalBlock({
            batch: entry({
                removals: [{ label: 'Unsorted', count: 3, removal: true }],
                removals_overflow: 2,
            }),
            heading: 'Removed',
        });
        expect(text(node)).toContain('+ 2 more');
    });

    it('says nothing when it listed every row', () => {
        const node = BatchRemovalBlock({
            batch: entry({ removals: [{ label: 'Unsorted', count: 3, removal: true }] }),
            heading: 'Removed',
        });
        expect(text(node)).not.toContain('more');
    });
});

describe('BatchFailureReasonBlock', () => {
    it('reports the reasons it hid', () => {
        const node = BatchFailureReasonBlock({
            batch: entry({
                failure_reasons: [{ label: 'Scanned, needs OCR', count: 6 }],
                failure_reasons_overflow: 3,
            }),
            heading: 'Could not be read',
        });
        expect(text(node)).toContain('+ 3 more');
    });

    it('says nothing when it listed every reason', () => {
        const node = BatchFailureReasonBlock({
            batch: entry({ failure_reasons: [{ label: 'Scanned, needs OCR', count: 6 }] }),
            heading: 'Could not be read',
        });
        expect(text(node)).not.toContain('more');
    });
});
