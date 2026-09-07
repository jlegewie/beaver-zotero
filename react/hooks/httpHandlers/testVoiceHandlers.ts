import type { VoiceHarnessRequest } from '../../../src/services/voice/developmentHarness';
import { store } from '../../store';
import { sessionAtom } from '../../atoms/auth';

/** Fake voice sessions only; registered by the existing authenticated development endpoint gate. */
export async function handleTestVoiceHttpRequest(request: VoiceHarnessRequest) {
    const service = Zotero.Beaver?.voice;
    const harness = Zotero.Beaver?.voiceHarness;
    if (!service || !harness || Zotero.Beaver.data.env !== 'development') throw new Error('Voice harness unavailable');
    if (request.command === 'start') {
        const expectedUserId = store.get(sessionAtom)?.user.id;
        if (!expectedUserId) return { ...harness.run({ command: 'state' }), result: { error: { code: 'unauthenticated' } } };
        const result = harness.start(expectedUserId, async () => {
            const session = store.get(sessionAtom);
            return session ? { userId: session.user.id, credential: 'fake-only' } : null;
        });
        return { ...harness.run({ command: 'state' }), result };
    }
    return harness.run(request);
}
