import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@beaver/agent-core/agents/types';

vi.mock('@beaver/agent-ui/chat/Citation', () => ({
    default: (props: Record<string, unknown>) =>
        React.createElement('span', { 'data-cite': props['data-zotero-key'] }),
}));

import { stripCitationMarkerChars } from '../../../react/utils/citationPreprocessing';
import { TextPartView } from '../../../react/components/agentRuns/TextPartView';
import { extractRunResponseContent } from '../../../react/utils/threadContent';

const OPEN = '';
const SEP = '';
const CLOSE = '';
const PUA = /[-]/;

describe('stripCitationMarkerChars', () => {
    it('removes the private-use citation markers and keeps everything else', () => {
        expect(stripCitationMarkerChars(`Claim ${OPEN}cite${SEP}u-3KZ8WPLD${CLOSE}.`)).toBe('Claim citeu-3KZ8WPLD.');
        expect(stripCitationMarkerChars(`A${OPEN}<citation id="u-SN968XEJ"/>${CLOSE} b`)).toBe('A<citation id="u-SN968XEJ"/> b');
    });

    it('restores the "<" of a tag whose opening bracket was replaced by the marker', () => {
        expect(stripCitationMarkerChars(`A ${OPEN}citation id="u-IICQGE6A" loc="page1"/><citation id="u-YFIYZV2V"/>`))
            .toBe('A <citation id="u-IICQGE6A" loc="page1"/><citation id="u-YFIYZV2V"/>');
        expect(stripCitationMarkerChars(`A ${OPEN}Citation id="u-IICQGE6A"/>`)).toBe('A <citation id="u-IICQGE6A"/>');
    });

    it('does not add a "<" where the marker is not followed by a complete tag', () => {
        expect(stripCitationMarkerChars(`A ${OPEN}citation${SEP}g12-ABCD2345${CLOSE}`)).toBe('A citationg12-ABCD2345');
        expect(stripCitationMarkerChars(`A ${OPEN}citations matter`)).toBe('A citations matter');
        expect(stripCitationMarkerChars(`A ${OPEN}citation is required${CLOSE}. More.`)).toBe('A citation is required. More.');
        expect(stripCitationMarkerChars(`A ${OPEN}citation\nid="u-SN968XEJ"/>`)).toBe('A citation\nid="u-SN968XEJ"/>');
    });

    it('does not complete an unfinished tag with the next marked tag', () => {
        expect(stripCitationMarkerChars(`A ${OPEN}citation id="u-SN968XEJ" loc="s7.5" ${OPEN}citation id="u-IICQGE6A"/> B`))
            .toBe('A citation id="u-SN968XEJ" loc="s7.5" <citation id="u-IICQGE6A"/> B');
    });

    it('leaves neighbouring private-use characters alone', () => {
        expect(stripCitationMarkerChars('')).toBe('');
    });
});

describe('TextPartView', () => {
    const render = (content: string) =>
        renderToStaticMarkup(React.createElement(TextPartView, { part: { part_kind: 'text', content } }));

    it('renders the citation without the markers around it', () => {
        const html = render(`Finding${OPEN}<citation id="u-SN968XEJ"/>${CLOSE}.`);
        expect(html).not.toMatch(PUA);
        expect(html).toContain('data-cite="SN968XEJ"');
    });

    it('renders a tag whose "<" was replaced by the marker as a citation', () => {
        for (const tag of ['citation', 'Citation']) {
            const html = render(`Finding ${OPEN}${tag} id="u-IICQGE6A"/>. After.`);
            expect(html).toContain('data-cite="IICQGE6A"');
            expect(html).toContain('After.');
            expect(html).not.toContain('citation id=');
        }
    });

    it('keeps prose that merely starts with "citation" after a marker', () => {
        expect(render(`A ${OPEN}citation is required${CLOSE}. More text.`)).toContain('A citation is required. More text.');
    });

    it('renders nothing for a part that holds only markers', () => {
        expect(render(`${OPEN}${SEP}${CLOSE}`)).toBe('');
    });

    it('hides only the exact "_" placeholder, not a padded underscore', () => {
        expect(render('_')).toBe('');
        expect(render(' _ ')).toContain('_');
    });
});

describe('extractRunResponseContent', () => {
    it('drops the markers from copied response text', () => {
        const run = {
            model_messages: [{
                kind: 'response',
                parts: [{ part_kind: 'text', content: `Claim${OPEN}<citation id="u-SN968XEJ"/>${CLOSE} ${OPEN}citation id="u-IICQGE6A"/>` }],
            }],
        } as unknown as AgentRun;
        expect(extractRunResponseContent(run, new Map()))
            .toBe('Claim<citation id="u-SN968XEJ"/> <citation id="u-IICQGE6A"/>');
    });
});
