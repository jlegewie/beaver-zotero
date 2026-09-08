import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceController } from '@beaver/agent-core/voice/controller';
import { FakeVoiceCapture, FakeVoiceTranscription } from '@beaver/agent-core/voice/fakes';
import { VOICE_FORMAT, VOICE_LIMITS, projectVoice,
    type VoiceDependencies, type VoiceFrame } from '@beaver/agent-core/voice/contracts';

const owner = { windowId: 'main', output: { kind: 'composer' as const, id: 'editor' } };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
function fixture(overrides: Partial<VoiceDependencies> = {}) {
    let capture!: FakeVoiceCapture;
    let transcription!: FakeVoiceTranscription;
    let id = 0;
    const deps: VoiceDependencies = {
        clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
        createId: () => `session-${++id}`, getAuth: async () => ({ userId: 'user', credential: 'credential' }),
        capability: () => ({ enabled: true, available: true }),
        createCapture: (session, emit) => capture = new FakeVoiceCapture(session, emit),
        createTranscription: (session, emit) => transcription = new FakeVoiceTranscription(session, emit),
        ...overrides,
    };
    const controller = new VoiceController(deps);
    return { controller, deps, get capture() { return capture; }, get transcription() { return transcription; },
        async start() { controller.start(owner, 'user'); await settle(); return controller.getSnapshot().sessionId!; },
        frame(overrides: Partial<VoiceFrame> = {}) {
            capture.emit({ ...capture.session, type: 'frame', frame: {
                ...capture.session, sequence: controller.getSnapshot().frameCount, sampleCount: 1600,
                format: VOICE_FORMAT, pcm: new Uint8Array(3200), ...overrides,
            } });
        },
    };
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('voice session lifecycle', () => {
    it('authenticates before starting capture and separates readiness from audio flow', async () => {
        const auth = deferred<{ userId: string; credential: string }>();
        const f = fixture({ getAuth: () => auth.promise });
        f.controller.start(owner, 'user');
        expect(f.capture).toBeUndefined();
        auth.resolve({ userId: 'user', credential: 'secret' });
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'listening', captureReady: true, audioStarted: false });
        f.capture.frame();
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({ audioStarted: true, frameCount: 1, sampleCount: 1600 });
        expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('secret');
    });

    it('flushes the short tail after queued frames, then awaits a distinct completion', async () => {
        const f = fixture(); const id = await f.start();
        f.transcription.autoComplete = false;
        f.capture.frame();
        f.transcription.text('interim', 0, 'Hel');
        f.transcription.text('interim', 0, 'Hello');
        f.transcription.text('segment_final', 0, 'Hello');
        expect(f.controller.getSnapshot().phase).toBe('listening');
        f.controller.finish(id); f.controller.finish(id);
        await settle();
        expect(f.capture.finishCount).toBe(1);
        expect(f.transcription.endAudio).toEqual({ type: 'end_audio', version: 1, sessionId: id, frameCount: 2, sampleCount: 2240 });
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'finalizing', committedText: 'Hello', provisionalText: '' });
        f.transcription.complete();
        expect(f.controller.getSnapshot().phase).toBe('completed');
        f.controller.finish(id); f.controller.cancel(id); f.controller.dispose(); f.controller.dispose();
        expect(f.capture.disposeCount).toBe(1); expect(f.transcription.disposeCount).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['cancel', 'finish', 'window', 'logout', 'account', 'dispose', 'timeout'])(
        'revokes pending authentication on %s, ignoring its eventual result', async operation => {
            const auth = deferred<{ userId: string; credential: string }>();
            const f = fixture({ getAuth: () => auth.promise });
            const id = (f.controller.start(owner, 'user') as { sessionId: string }).sessionId;
            if (operation === 'cancel') f.controller.cancel(id);
            if (operation === 'finish') f.controller.finish(id);
            if (operation === 'window') f.controller.windowUnloaded(owner.windowId);
            if (operation === 'logout') f.controller.authChanged(null);
            if (operation === 'account') f.controller.authChanged('replacement');
            if (operation === 'dispose') f.controller.dispose();
            if (operation === 'timeout') vi.advanceTimersByTime(VOICE_LIMITS.startupMs);
            auth.resolve({ userId: 'user', credential: 'secret' }); await settle();
            expect(f.capture).toBeUndefined(); expect(f.transcription).toBeUndefined();
            expect(f.controller.getSnapshot().phase).toBe(operation === 'timeout' ? 'error' : 'canceled');
        });

    it.each(['capture', 'transcription'])('cancels pending %s setup with immediate disposal', async stage => {
        const ready = deferred(); const f = fixture();
        const create = stage === 'capture' ? f.deps.createCapture : f.deps.createTranscription;
        if (stage === 'capture') f.deps.createCapture = (s, emit) => {
            const result = create(s, emit as never) as FakeVoiceCapture;
            result.start = () => ready.promise; return result;
        };
        else f.deps.createTranscription = (s, emit) => {
            const result = create(s, emit as never) as FakeVoiceTranscription;
            result.start = () => ready.promise; return result;
        };
        const id = await f.start();
        f.controller.cancel(id);
        expect(f.transcription.disposed).toBe(true);
        if (stage === 'capture') expect(f.capture.disposed).toBe(true);
        ready.resolve(); await settle();
        expect(f.controller.getSnapshot().phase).toBe('canceled');
    });

    it('keeps one lock across originating windows and rejects stale commands', async () => {
        const f = fixture(); const id = await f.start();
        expect(f.controller.start({ ...owner, windowId: 'other' }, 'user')).toEqual({ error: { code: 'busy' } });
        f.controller.windowUnloaded('other'); f.controller.authChanged('user');
        expect(f.controller.getSnapshot().phase).toBe('listening');
        f.controller.windowUnloaded('main');
        const next = await f.start(); expect(next).not.toBe(id);
        f.controller.cancel(id); f.controller.finish(id);
        expect(f.controller.getSnapshot().phase).toBe('listening');
    });

    it('ignores old session callbacks after a new activation', async () => {
        const f = fixture(); const id = await f.start();
        const old = f.transcription;
        f.controller.cancel(id); await f.start();
        old.emit({ ...old.session, type: 'segment_final', sequence: 0, segmentId: 0, text: 'stale' });
        expect(f.controller.getSnapshot().committedText).toBe('');
    });

    it.each(['startup_timeout', 'finalization_timeout', 'duration_limit'] as const)('enforces %s without timer leaks', async code => {
        const f = fixture(code === 'startup_timeout' ? { getAuth: () => new Promise(() => {}) } : {});
        const id = await f.start();
        if (code === 'finalization_timeout') { f.transcription.autoComplete = false; f.controller.finish(id); await settle(); }
        vi.advanceTimersByTime(code === 'startup_timeout' ? VOICE_LIMITS.startupMs
            : code === 'finalization_timeout' ? VOICE_LIMITS.finalizationMs : VOICE_LIMITS.durationMs);
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', error: { code } });
        expect(vi.getTimerCount()).toBe(0);
        if (f.capture) expect(f.capture.disposed).toBe(true);
    });

    it('bounds a stalled capture finish and ignores its eventual tail', async () => {
        const f = fixture(); const id = await f.start(); const stopped = deferred();
        f.capture.finish = () => stopped.promise;
        f.controller.finish(id); vi.advanceTimersByTime(VOICE_LIMITS.finalizationMs);
        stopped.resolve(); await settle();
        expect(f.transcription.endAudio).toBeUndefined();
        expect(f.controller.getSnapshot().error?.code).toBe('finalization_timeout');
    });

    it('disposes both resources even if one disposal throws or observers fail', async () => {
        const f = fixture(); await f.start();
        f.controller.subscribe(() => { throw new Error('view failed'); });
        f.capture.dispose = () => { throw new Error('device failed'); };
        f.controller.authChanged(null);
        expect(f.transcription.disposed).toBe(true);
        expect(f.controller.getSnapshot().phase).toBe('canceled');
    });

    it('does not create resources when a state observer cancels activation', async () => {
        const f = fixture();
        f.controller.subscribe(() => {
            if (f.controller.getSnapshot().phase === 'starting') f.controller.windowUnloaded('main');
        });
        const result = f.controller.start(owner, 'user'); await settle();
        expect(result).toEqual({ sessionId: f.controller.getSnapshot().sessionId });
        expect(f.controller.getSnapshot().phase).toBe('canceled');
        expect(f.capture).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        [{ enabled: false, available: true }, 'disabled'],
        [{ enabled: true, available: false }, 'unavailable'],
    ] as const)('gates activation with %s', (capability, code) => {
        const f = fixture({ capability: () => capability });
        expect(f.controller.start(owner, 'user')).toEqual({ error: { code } });
        expect(f.controller.getSnapshot().phase).toBe('idle');
    });
    it('rejects missing auth and a disposed controller', async () => {
        const f = fixture({ getAuth: async () => null }); await f.start();
        expect(f.controller.getSnapshot().error?.code).toBe('unauthenticated');
        expect(f.capture).toBeUndefined(); f.controller.dispose();
        expect(f.controller.start(owner, 'user')).toEqual({ error: { code: 'disabled' } });
    });
});

describe('audio bounds and ordering', () => {
    it('counts the in-flight send in its bound and stops rather than dropping speech', async () => {
        const f = fixture(); await f.start();
        const send = deferred(); f.transcription.send = () => send.promise;
        for (let i = 0; i < VOICE_LIMITS.queuedBytes / 3200; i++) f.capture.frame();
        expect(f.controller.getSnapshot().phase).toBe('listening');
        f.capture.frame();
        expect(f.controller.getSnapshot().error?.code).toBe('overflow');
        expect(f.capture.disposed).toBe(true); send.resolve(); await settle();
        expect(f.transcription.endAudio).toBeUndefined();
    });
    it('does not send end-of-audio until the last send resolves', async () => {
        const f = fixture(); const id = await f.start(); const send = deferred();
        const frames: number[] = [];
        f.transcription.send = async frame => { frames.push(frame.sequence); await send.promise; };
        f.capture.frame(); f.capture.frame(); f.controller.finish(id); await settle();
        expect(f.transcription.endAudio).toBeUndefined();
        send.resolve(); await settle();
        expect(frames).toEqual([0, 1, 2]); expect(f.controller.getSnapshot().phase).toBe('completed');
    });
    it('copies bytes before the capture adapter reuses a buffer and calculates levels', async () => {
        const f = fixture(); await f.start(); let sent!: Uint8Array;
        f.transcription.send = async frame => { sent = frame.pcm; };
        const pcm = new Uint8Array(3200); for (let i = 1; i < pcm.length; i += 2) pcm[i] = 64;
        f.frame({ pcm }); pcm.fill(0);
        expect(sent[1]).toBe(64); expect(f.controller.getSnapshot().level).toBe(0.5);
    });
    it.each([
        { sequence: 1 }, { sequence: -1 }, { sampleCount: 1601 }, { sampleCount: 0 },
        { sampleCount: 640, pcm: new Uint8Array(1280) }, { pcm: new Uint8Array(3) },
        { version: 2 }, { sessionId: 'wrong' }, { format: { ...VOICE_FORMAT, sampleRate: 48000 } },
    ])('rejects invalid frame %s', async patch => {
        const f = fixture(); await f.start(); f.frame(patch as Partial<VoiceFrame>);
        expect(f.controller.getSnapshot().error?.code).toBe('protocol_error');
    });
    it('rejects audio after a short final frame', async () => {
        const f = fixture(); const id = await f.start();
        f.capture.finish = async () => { f.capture.frame(640); f.capture.frame(); };
        f.controller.finish(id); await settle();
        expect(f.controller.getSnapshot().error?.code).toBe('protocol_error');
    });
    it('treats silence as audio and discontinuity as a distinct recoverable error', async () => {
        const f = fixture(); await f.start(); f.capture.frame();
        expect(f.controller.getSnapshot()).toMatchObject({ audioStarted: true, level: 0, error: null });
        f.transcription.text('segment_final', 0, 'keep');
        f.capture.emit({ ...f.capture.session, type: 'error', error: { code: 'discontinuity' } });
        expect(f.controller.getSnapshot()).toMatchObject({ committedText: 'keep', error: { code: 'discontinuity' } });
    });
});

describe('transcript ordering and UI projection', () => {
    it('replaces hypotheses, commits once, and ignores late updates to finalized segments', async () => {
        const f = fixture(); await f.start();
        f.transcription.text('interim', 0, 'a'); f.transcription.text('interim', 0, 'abc');
        expect(f.controller.getSnapshot().provisionalText).toBe('abc');
        f.transcription.text('segment_final', 0, 'abc');
        f.transcription.emit({ ...f.transcription.session, type: 'segment_final', sequence: 2, segmentId: 0, text: 'duplicate' });
        f.transcription.text('interim', 0, 'late'); f.transcription.text('segment_final', 0, 'late final');
        f.transcription.text('segment_final', 1, ' def');
        expect(f.controller.getSnapshot()).toMatchObject({ committedText: 'abc def', provisionalText: '', phase: 'listening' });
    });
    it('rejects completion before finish and never promotes provisional text', async () => {
        const f = fixture(); await f.start();
        f.transcription.text('segment_final', 0, 'keep'); f.transcription.text('interim', 1, 'discard');
        f.transcription.complete();
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', committedText: 'keep', provisionalText: '', error: { code: 'protocol_error' } });
    });
    it('requires the final transcript before the completion acknowledgement', async () => {
        const f = fixture(); const id = await f.start(); f.transcription.text('interim', 0, 'pending');
        f.controller.finish(id); await settle();
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', committedText: '', error: { code: 'protocol_error' } });
    });
    it.each(['disconnected', 'permission_denied', 'device_unavailable'] as const)('preserves committed text on %s', async code => {
        const f = fixture(); await f.start(); f.transcription.text('segment_final', 0, 'keep');
        f.transcription.text('interim', 1, 'discard');
        f.transcription.emit({ ...f.transcription.session, type: 'error', error: { code } });
        expect(f.controller.getSnapshot()).toMatchObject({ committedText: 'keep', provisionalText: '', error: { code } });
        expect(f.capture.disposed).toBe(true);
    });
    it.each([null, 42])('rejects malformed transcript text %s and disposes adapters', async text => {
        const f = fixture(); await f.start();
        f.transcription.text('segment_final', 0, 'keep');
        f.transcription.text('interim', 1, text as unknown as string);
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', committedText: 'keep', error: { code: 'protocol_error' } });
        expect(f.capture.disposeCount).toBe(1);
        expect(f.transcription.disposeCount).toBe(1);
    });
    it('rejects transcript gaps and bounds retained text', async () => {
        const f = fixture(); await f.start();
        f.transcription.emit({ ...f.transcription.session, type: 'interim', sequence: 1, segmentId: 0, text: 'gap' });
        expect(f.controller.getSnapshot().error?.code).toBe('protocol_error');
        await f.start(); f.transcription.text('segment_final', 1, 'gap');
        expect(f.controller.getSnapshot().error?.code).toBe('protocol_error');
        await f.start(); f.transcription.text('interim', 0, 'x'.repeat(VOICE_LIMITS.transcriptCharacters + 1));
        expect(f.controller.getSnapshot().error?.code).toBe('overflow');
    });
    it('makes observation shared but insertion ownership explicit and immutable', async () => {
        const f = fixture(); const mutableOwner = { ...owner, output: { ...owner.output } };
        f.controller.start(mutableOwner, 'user'); mutableOwner.output.id = 'changed'; await settle();
        const snapshot = f.controller.getSnapshot();
        expect(projectVoice(snapshot, owner)).toMatchObject({ ownsOutput: true, busy: true });
        expect(projectVoice(snapshot, { ...owner, windowId: 'other' })).toMatchObject({ ownsOutput: false, busy: true });
        expect(Object.isFrozen(snapshot.owner?.output)).toBe(true);
        let count = 0; const off = f.controller.subscribe(() => count++); off(); f.capture.frame(); expect(count).toBe(0);
    });
});

describe('adapter failures and cancellation during upload', () => {
    it.each(['send', 'finish'] as const)('disposes resources and preserves committed text when transport %s rejects', async operation => {
        const f = fixture(); const id = await f.start();
        f.transcription.text('segment_final', 0, 'keep');
        f.transcription[operation] = async () => { throw new Error('private provider details'); };
        if (operation === 'send') f.capture.frame();
        else f.controller.finish(id);
        await settle();
        expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', committedText: 'keep', error: { code: 'transcription_failed' } });
        expect(f.capture.disposed).toBe(true); expect(f.transcription.disposed).toBe(true);
        expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('private provider details');
    });

    it.each(['auth', 'transcription_factory', 'transcription_start', 'capture_factory', 'capture_start'])(
        'classifies %s failure and disposes every handle already allocated', async stage => {
            const f = fixture();
            const fail = () => { throw new Error('setup failed'); };
            if (stage === 'auth') f.deps.getAuth = fail;
            if (stage === 'transcription_factory') f.deps.createTranscription = fail;
            if (stage === 'capture_factory') f.deps.createCapture = fail;
            if (stage === 'transcription_start') {
                const create = f.deps.createTranscription;
                f.deps.createTranscription = (s, emit) => { const t = create(s, emit); t.start = fail; return t; };
            }
            if (stage === 'capture_start') {
                const create = f.deps.createCapture;
                f.deps.createCapture = (s, emit) => { const c = create(s, emit); c.start = fail; return c; };
            }
            await f.start();
            expect(f.controller.getSnapshot().error?.code).toBe(stage === 'auth' ? 'unauthenticated'
                : stage.startsWith('capture') ? 'capture_failed' : 'transcription_failed');
            if (f.capture) expect(f.capture.disposed).toBe(true);
            if (f.transcription) expect(f.transcription.disposed).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        });

    it('discards queued frames on cancel and never resumes uploading after a late send resolution', async () => {
        const f = fixture(); const id = await f.start(); const send = deferred(); let count = 0;
        f.transcription.send = async () => { count++; await send.promise; };
        f.capture.frame(); f.capture.frame(); f.capture.frame();
        f.controller.finish(id); await settle(); f.controller.cancel(id);
        expect(count).toBe(1); send.resolve(); await settle();
        expect(count).toBe(1); expect(f.transcription.endAudio).toBeUndefined();
        expect(f.controller.getSnapshot().phase).toBe('canceled');
    });
});

it('keeps a pending session when another window reports the expected account', async () => {
    const auth = deferred<{ userId: string; credential: string }>();
    const f = fixture({ getAuth: () => auth.promise });
    f.controller.start(owner, 'user');
    f.controller.authChanged('user');
    expect(f.controller.getSnapshot().phase).toBe('starting');
    auth.resolve({ userId: 'user', credential: 'credential' }); await settle();
    expect(f.controller.getSnapshot().phase).toBe('listening');
});

it.each(['notification', 'credentials'])('revokes a bound activation on account replacement via %s', async source => {
    const auth = deferred<{ userId: string; credential: string }>();
    const f = fixture({ getAuth: () => auth.promise });
    f.controller.start(owner, 'user');
    if (source === 'notification') f.controller.authChanged('other');
    auth.resolve({ userId: 'other', credential: 'credential' }); await settle();
    expect(f.controller.getSnapshot().phase).toBe('canceled');
    expect(f.capture).toBeUndefined(); expect(f.transcription).toBeUndefined();
});
