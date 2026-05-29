import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../../src/utils/compareVersions';

describe('compareVersions', () => {
    it('orders prereleases before the final release', () => {
        expect(compareVersions('0.20.0-beta.1', '0.20.0')).toBeLessThan(0);
        expect(compareVersions('0.20.0', '0.20.0-beta.1')).toBeGreaterThan(0);
    });

    it('orders prerelease numbers numerically', () => {
        expect(compareVersions('0.20.0-beta.2', '0.20.0-beta.10')).toBeLessThan(0);
        expect(compareVersions('0.20.0-beta.10', '0.20.0-beta.2')).toBeGreaterThan(0);
    });

    it('treats missing release parts as zero', () => {
        expect(compareVersions('0.20', '0.20.0')).toBe(0);
    });

    it('ignores build metadata', () => {
        expect(compareVersions('0.20.0+build.1', '0.20.0+build.2')).toBe(0);
    });
});
