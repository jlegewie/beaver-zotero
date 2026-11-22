import { describe, expect, it } from 'vitest';
import { getFirstRunVariant } from '../../../react/utils/firstRunSelection';

describe('getFirstRunVariant', () => {
    it('matches the documented hash so analysis can recompute it', () => {
        // FNV-1a("first_run_v2:00000000-0000-0000-0000-000000000000") = 3789556102; % 100 = 2.
        expect(getFirstRunVariant('00000000-0000-0000-0000-000000000000')).toBe('feature_credits');
    });

    it('is the same for an id in any letter case', () => {
        const id = '3F2A9C1E-7B4D-4E8A-9C0B-1D2E3F4A5B6C';
        expect(getFirstRunVariant(id)).toBe(getFirstRunVariant(id.toLowerCase()));
    });

    it('splits accounts about evenly', () => {
        let credits = 0;
        const n = 4000;
        for (let i = 0; i < n; i++) {
            const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-${(i * 7919).toString(16).padStart(12, '0')}`;
            if (getFirstRunVariant(id) === 'feature_credits') credits++;
        }
        expect(credits / n).toBeGreaterThan(0.45);
        expect(credits / n).toBeLessThan(0.55);
    });
});
