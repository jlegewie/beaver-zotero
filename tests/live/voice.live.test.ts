import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import type { VoiceSnapshot } from '@beaver/agent-core/voice/contracts';
import fixture from '../fixtures/voice/session.json';

interface HarnessResult {
    state: VoiceSnapshot;
    result?: { sessionId?: string; error?: { code: string } };
    resources: { sentFrames: number;
        captureDisposeCount: number; transcriptionDisposeCount: number; endAudio: unknown };
}
const command = (command: string, data = {}) => post<HarnessResult>('/beaver/test/voice', { command, ...data });
async function phase(expected: string) {
    let result = await command('state');
    for (let i = 0; i < 40 && result.state.phase !== expected; i++) {
        await new Promise(resolve => setTimeout(resolve, 50)); result = await command('state');
    }
    expect(result.state.phase).toBe(expected);
    return result;
}
let available: boolean;
beforeAll(async () => { available = await isZoteroAvailable(); });
beforeEach(async ctx => {
    skipIfNoZotero(ctx, available);
    await command('cancel'); await command('enable', { enabled: true });
});
afterAll(async () => { if (available) await command('enable', { enabled: false }); });

describe('voice fake harness in Zotero', () => {
    it('replays the protocol fixture, flushes its tail, and completes without an agent run', async () => {
        const before = await post('/beaver/test/current-ids', {});
        const started = await command('start'); expect(started.result?.sessionId).toBeTruthy();
        await phase('listening');
        await command('frame');
        for (const event of fixture.transcript.filter(event => event.type !== 'complete')) {
            await command(event.type, { segmentId: event.segmentId, text: event.text });
        }
        const mid = await command('state');
        expect(mid.state).toMatchObject({ phase: 'listening', committedText: fixture.committedText, frameCount: 1 });
        await command('finish'); const done = await phase('completed');
        expect(done.state).toMatchObject({ committedText: fixture.committedText, sampleCount: 2240, provisionalText: '' });
        expect(done.resources).toMatchObject({ sentFrames: 2, captureDisposeCount: 1, transcriptionDisposeCount: 1, endAudio: fixture.endAudio });
        expect(await post('/beaver/test/current-ids', {})).toEqual(before);
    });
    it('locks competing starts and cancels idempotently without committing a hypothesis', async () => {
        await command('start'); await phase('listening');
        expect((await command('start')).result?.error?.code).toBe('busy');
        await command('interim', { segmentId: 0, text: 'Do not commit this' });
        await command('cancel'); await command('cancel'); await command('finish');
        const done = await command('state');
        expect(done.state).toMatchObject({ phase: 'canceled', committedText: '', provisionalText: '' });
        expect(done.resources).toMatchObject({ captureDisposeCount: 1, transcriptionDisposeCount: 1, endAudio: null });
    });
    it('can restart repeatedly and disabling the harness cancels the active session', async () => {
        for (let i = 0; i < 3; i++) {
            await command('start'); await phase('listening'); await command('frame');
            await command('cancel'); await phase('canceled');
        }
        await command('start'); await phase('listening');
        await command('enable', { enabled: false }); await phase('canceled');
        expect((await command('start')).result?.error?.code).toBe('disabled');
    });
});
