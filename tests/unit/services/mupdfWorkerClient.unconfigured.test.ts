import { expect, it } from 'vitest';
import { MuPDFWorkerClient } from '../../../src/beaver-extract/MuPDFWorkerClient';
import { isConfigured } from '../../../src/beaver-extract/config';

it('can construct and dispose a client before PDF configuration', async () => {
    expect(isConfigured()).toBe(false);
    const client = new MuPDFWorkerClient();
    expect(client.getStats().hasWorker).toBe(false);
    await client.dispose();
    expect(client.getStats().disposed).toBe(true);
});
