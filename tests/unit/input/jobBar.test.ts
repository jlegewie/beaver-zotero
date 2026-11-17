// @vitest-environment jsdom
/**
 * The job bar and its stack: states, tones, actions, links, expansion, folding
 * and the ready announcement. Mounted for real (jsdom) so clicks, focus
 * semantics and effects run.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobBar } from '@beaver/agent-ui/chat/JobBar';
import type { JobView } from '@beaver/agent-ui/chat/JobBar';
import { JobBarStack } from '@beaver/agent-ui/chat/JobBarStack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    root = null;
    container = null;
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(node));
    return container;
}

async function rerender(node: React.ReactElement): Promise<void> {
    await act(async () => root!.render(node));
}

function job(overrides: Partial<JobView> = {}): JobView {
    return {
        id: 'j1',
        kind: 'table_fill',
        verb: 'Filling table',
        subject: 'Soil carbon studies',
        state: 'running',
        progress: { done: 4, failed: 1, total: 10 },
        status: '5 of 10 papers',
        links: [],
        actions: [],
        ...overrides,
    };
}

const q = (el: ParentNode, sel: string) => el.querySelector(sel) as HTMLElement | null;
const buttonByText = (el: ParentNode, text: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('the job bar surface', () => {
    it('shares the batch bar surface and is a labelled group', async () => {
        const el = await mount(React.createElement(JobBar, { job: job() }));
        const root = q(el, '.composer-docked-bar')!;
        expect(root.classList.contains('batch-progress-bar')).toBe(true);
        expect(root.getAttribute('role')).toBe('group');
        expect(root.getAttribute('aria-label')).toBe('Filling table');
    });

    it('shows what the job does on line one, without its subject, and the status on line two', async () => {
        const el = await mount(React.createElement(JobBar, { job: job() }));
        expect(q(el, '.job-bar-title')!.textContent).toBe('Filling table');
        expect(el.textContent).not.toContain('Soil carbon studies');
        expect(q(el, '.job-bar-status')!.textContent).toBe('5 of 10 papers');
    });

    it('sets failures off in the warning color after the status', async () => {
        const el = await mount(React.createElement(JobBar, { job: job({ statusWarning: '1 failed' }) }));
        expect(q(el, '.job-bar-status-text')!.textContent).toBe('5 of 10 papers');
        expect(q(el, '.job-bar-status-warning')!.textContent).toBe('1 failed');
    });

    it('offers the subject link only when the job can be opened', async () => {
        const open = vi.fn();
        const el = await mount(React.createElement(JobBar, { job: job({ open }) }));
        const openBtn = q(el, 'button[aria-label="Open Soil carbon studies"]')!;
        await act(async () => openBtn.click());
        expect(open).toHaveBeenCalledTimes(1);

        await rerender(React.createElement(JobBar, { job: job() }));
        expect(q(el, 'button[aria-label^="Open "]')).toBeNull();
    });
});

describe('hairline and glyph by state', () => {
    it('draws done and failed segments while running', async () => {
        const el = await mount(React.createElement(JobBar, { job: job() }));
        const hairline = q(el, '.batch-progress-hairline')!;
        const segments = Array.from(hairline.children) as HTMLElement[];
        expect(segments.map((s) => s.style.width)).toEqual(['40%', '10%']);
        expect(hairline.getAttribute('aria-valuenow')).toBe('5');
        expect(hairline.getAttribute('aria-valuemax')).toBe('10');
        expect(q(el, '.job-bar-glyph')!.tagName.toLowerCase()).toBe('svg');
        expect(q(el, '.job-bar-glyph')!.getAttribute('style')).toContain('spin');
    });

    it.each([
        ['indeterminate', 'indeterminate' as const],
        ['no progress', undefined],
        ['zero done', { done: 0, failed: 0, total: 10 }],
    ])('sweeps when progress is %s', async (_name, progress) => {
        const el = await mount(React.createElement(JobBar, { job: job({ progress }) }));
        expect(q(el, '.batch-progress-hairline .batch-progress-indeterminate')).not.toBeNull();
    });

    it('keeps the hairline, faded by class, while stopping', async () => {
        const el = await mount(React.createElement(JobBar, { job: job({ state: 'stopping', status: 'Stopping…' }) }));
        expect(q(el, '.job-bar-stopping .batch-progress-hairline')).not.toBeNull();
        expect(q(el, '.job-bar-glyph')!.getAttribute('style')).toContain('spin');
    });

    it('sweeps neutrally and spins on another device, naming it when the status is empty', async () => {
        const el = await mount(
            React.createElement(JobBar, { job: job({ state: 'elsewhere', status: '', device: 'Office Mac' }) }),
        );
        const hairline = q(el, '.batch-progress-hairline')!;
        expect(hairline.classList.contains('job-bar-hairline-neutral')).toBe(true);
        expect(hairline.querySelector('.batch-progress-indeterminate')).not.toBeNull();
        expect(q(el, '.job-bar-glyph')!.getAttribute('style')).toContain('spin');
        expect(q(el, '.job-bar-status')!.textContent).toBe('Running on Office Mac');
    });

    it.each([
        ['clean', 'font-color-green'],
        [undefined, 'font-color-green'],
        ['warning', 'font-color-orange'],
        ['error', 'font-color-red'],
    ] as const)('has no hairline and a %s glyph when ready', async (tone, glyphClass) => {
        const el = await mount(
            React.createElement(JobBar, { job: job({ state: 'ready', tone, progress: undefined, status: 'Done' }) }),
        );
        expect(q(el, '.batch-progress-hairline')).toBeNull();
        const glyph = q(el, '.job-bar-glyph')!;
        expect(glyph.classList.contains(glyphClass)).toBe(true);
        expect(glyph.getAttribute('style') ?? '').not.toContain('spin');
    });

    it('uses a different glyph for each ready tone', async () => {
        const paths: string[] = [];
        for (const tone of ['clean', 'warning', 'error'] as const) {
            const el = await mount(React.createElement(JobBar, { job: job({ state: 'ready', tone }) }));
            paths.push(q(el, '.job-bar-glyph')!.innerHTML);
            await act(async () => root!.unmount());
            container!.remove();
            root = null;
        }
        expect(new Set(paths).size).toBe(3);
    });
});

describe('actions and links', () => {
    it('runs the clicked action', async () => {
        const stop = vi.fn();
        const el = await mount(
            React.createElement(JobBar, { job: job({ actions: [{ id: 'stop', label: 'Stop', onClick: stop }] }) }),
        );
        await act(async () => buttonByText(el, 'Stop').click());
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('does not run a disabled action', async () => {
        const stop = vi.fn();
        const el = await mount(
            React.createElement(JobBar, {
                job: job({ state: 'stopping', actions: [{ id: 'stop', label: 'Stop', disabled: true, onClick: stop }] }),
            }),
        );
        const btn = buttonByText(el, 'Stop');
        expect(btn.disabled).toBe(true);
        await act(async () => btn.click());
        expect(stop).not.toHaveBeenCalled();
    });

    it('draws the primary action solid and the others ghost', async () => {
        const el = await mount(
            React.createElement(JobBar, {
                job: job({
                    state: 'ready',
                    actions: [
                        { id: 'dismiss', label: 'Later', onClick: () => {} },
                        { id: 'continue', label: 'Continue', primary: true, onClick: () => {} },
                    ],
                }),
            }),
        );
        expect(buttonByText(el, 'Continue').classList.contains('variant-solid')).toBe(true);
        expect(buttonByText(el, 'Later').classList.contains('variant-ghost')).toBe(true);
    });

    it('renders links after the status and calls them back', async () => {
        const show = vi.fn();
        const el = await mount(
            React.createElement(JobBar, {
                job: job({ state: 'ready', status: '3 could not be read', links: [{ label: 'Show', onClick: show }] }),
            }),
        );
        const status = q(el, '.job-bar-status')!;
        expect(status.textContent).toBe('3 could not be readShow');
        await act(async () => buttonByText(status, 'Show').click());
        expect(show).toHaveBeenCalledTimes(1);
    });
});

describe('expansion', () => {
    const withDetails = (overrides: Partial<JobView> = {}) =>
        job({ details: React.createElement('div', { className: 'the-details' }, 'Counts by source'), ...overrides });

    it('has no toggle without details', async () => {
        const el = await mount(React.createElement(JobBar, { job: job() }));
        expect(q(el, '.job-bar-toggle')).toBeNull();
    });

    it('starts collapsed and opens on the toggle, which reports aria-expanded', async () => {
        const el = await mount(React.createElement(JobBar, { job: withDetails() }));
        const toggle = q(el, '.job-bar-toggle') as HTMLButtonElement;
        expect(toggle.tagName).toBe('BUTTON');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(q(el, '.the-details')).toBeNull();

        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(q(el, '.the-details')!.textContent).toBe('Counts by source');
        expect(toggle.getAttribute('aria-controls')).toBe(q(el, '.the-details')!.parentElement!.parentElement!.id);

        await act(async () => toggle.click());
        expect(q(el, '.the-details')).toBeNull();
    });

    it('stays open when the job changes, including through completion', async () => {
        const el = await mount(React.createElement(JobBar, { job: withDetails() }));
        await act(async () => (q(el, '.job-bar-toggle') as HTMLButtonElement).click());
        await rerender(React.createElement(JobBar, { job: withDetails({ state: 'ready', status: 'Done' }) }));
        expect(q(el, '.the-details')).not.toBeNull();
        expect(q(el, '.job-bar-toggle')!.getAttribute('aria-expanded')).toBe('true');
    });

    it('follows `expanded` when the caller controls it and reports toggles', async () => {
        const onExpandedChange = vi.fn();
        const el = await mount(
            React.createElement(JobBar, { job: withDetails(), expanded: false, onExpandedChange }),
        );
        await act(async () => (q(el, '.job-bar-toggle') as HTMLButtonElement).click());
        expect(onExpandedChange).toHaveBeenCalledWith(true);
        // Controlled: nothing opens until the caller says so.
        expect(q(el, '.the-details')).toBeNull();
        await rerender(React.createElement(JobBar, { job: withDetails(), expanded: true, onExpandedChange }));
        expect(q(el, '.the-details')).not.toBeNull();
    });
});

describe('the ready announcement', () => {
    const live = (el: ParentNode) => q(el, '[aria-live="polite"]')!;

    it('is a polite live region that is silent while running', async () => {
        const el = await mount(React.createElement(JobBar, { job: job() }));
        expect(live(el)).not.toBeNull();
        expect(live(el).textContent).toBe('');
    });

    it('announces "verb · status" when the job becomes ready, once', async () => {
        const el = await mount(React.createElement(JobBar, { job: job() }));
        const region = live(el);
        await rerender(
            React.createElement(JobBar, { job: job({ state: 'ready', verb: 'Fill finished', status: '10 of 10 papers' }) }),
        );
        expect(live(el)).toBe(region);
        expect(region.textContent).toBe('Fill finished · 10 of 10 papers');

        // A later status change while ready does not re-announce.
        await rerender(
            React.createElement(JobBar, { job: job({ state: 'ready', verb: 'Fill finished', status: 'Changed' }) }),
        );
        expect(region.textContent).toBe('Fill finished · 10 of 10 papers');
    });

    it('announces a bar that first appears ready, and clears when the job runs again', async () => {
        const el = await mount(
            React.createElement(JobBar, { job: job({ state: 'ready', verb: 'Fill finished', status: 'Done' }) }),
        );
        expect(live(el).textContent).toBe('Fill finished · Done');
        await rerender(React.createElement(JobBar, { job: job() }));
        expect(live(el).textContent).toBe('');
    });
});

describe('the job bar stack', () => {
    const jobs = (n: number) =>
        Array.from({ length: n }, (_, i) => job({ id: `j${i}`, verb: `Table ${i}`, kind: 'table_fill' }));
    const subjects = (el: ParentNode) =>
        Array.from(el.querySelectorAll('.job-bar-title')).map((s) => s.textContent);

    it('renders one bar per job up to two, with no fold', async () => {
        const el = await mount(React.createElement(JobBarStack, { jobs: jobs(2) }));
        expect(subjects(el)).toEqual(['Table 0', 'Table 1']);
        expect(q(el, '.job-bar-more')).toBeNull();
    });

    it('renders nothing for no jobs', async () => {
        const el = await mount(React.createElement(JobBarStack, { jobs: [] }));
        expect(el.innerHTML).toBe('');
    });

    it('keeps the first two from three on and folds the rest into "+N more"', async () => {
        const el = await mount(React.createElement(JobBarStack, { jobs: jobs(5) }));
        expect(subjects(el)).toEqual(['Table 0', 'Table 1']);
        const more = q(el, '.job-bar-more-toggle')!;
        expect(more.textContent).toBe('+3 more');
        expect(more.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens to show them all and folds back', async () => {
        const el = await mount(React.createElement(JobBarStack, { jobs: jobs(3) }));
        const more = q(el, '.job-bar-more-toggle')!;
        await act(async () => more.click());
        expect(subjects(el)).toEqual(['Table 0', 'Table 1', 'Table 2']);
        expect(more.getAttribute('aria-expanded')).toBe('true');
        expect(more.textContent).toBe('Show fewer');
        await act(async () => more.click());
        expect(subjects(el)).toEqual(['Table 0', 'Table 1']);
    });

    it('keeps the bars as direct siblings so they stack flush', async () => {
        const el = await mount(React.createElement(JobBarStack, { jobs: jobs(3) }));
        const bars = Array.from(el.children);
        expect(bars).toHaveLength(3);
        expect(bars.every((b) => b.classList.contains('composer-docked-bar'))).toBe(true);
    });
});
