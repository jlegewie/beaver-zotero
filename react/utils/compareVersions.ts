/**
 * Parses a version string into its components
 * Handles formats like: "0.9.6", "0.10", "1.0.0", "0.9.7-beta.1", "0.10.0-beta.3"
 */
function parseVersion(version: string): { parts: number[]; preRelease: string | null; preReleaseNum: number | null } {
    // Split into main version and pre-release (e.g., "0.9.7-beta.1" -> ["0.9.7", "beta.1"])
    const [main, ...preParts] = version.split('-');
    const preRelease = preParts.length > 0 ? preParts.join('-') : null;
    
    // Parse main version parts (e.g., "0.10.0" -> [0, 10, 0])
    const parts = main.split('.').map(Number);
    
    // Parse pre-release number if present (e.g., "beta.1" -> 1)
    let preReleaseNum: number | null = null;
    if (preRelease) {
        const match = preRelease.match(/\.(\d+)$/);
        if (match) {
            preReleaseNum = parseInt(match[1], 10);
        }
    }
    
    return { parts, preRelease, preReleaseNum };
}

/**
 * Compares two semantic version strings
 * Properly handles:
 * - Different version lengths (0.10 vs 0.10.0)
 * - Multi-digit parts (0.10.0 > 0.9.7)
 * - Pre-release versions (0.9.7-beta.1 < 0.9.7)
 * - Pre-release ordering (0.9.7-beta.2 > 0.9.7-beta.1)
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
    const parsed1 = parseVersion(v1);
    const parsed2 = parseVersion(v2);
    
    // Compare main version parts
    const maxLength = Math.max(parsed1.parts.length, parsed2.parts.length);
    for (let i = 0; i < maxLength; i++) {
        const num1 = parsed1.parts[i] || 0;
        const num2 = parsed2.parts[i] || 0;
        if (num1 < num2) return -1;
        if (num1 > num2) return 1;
    }
    
    // Main versions are equal, compare pre-release status
    // A version without pre-release is greater than one with pre-release
    // e.g., 0.9.7 > 0.9.7-beta.1
    if (parsed1.preRelease && !parsed2.preRelease) return -1;
    if (!parsed1.preRelease && parsed2.preRelease) return 1;
    
    // Both have pre-release, compare pre-release numbers
    // e.g., 0.9.7-beta.2 > 0.9.7-beta.1
    if (parsed1.preRelease && parsed2.preRelease) {
        const num1 = parsed1.preReleaseNum || 0;
        const num2 = parsed2.preReleaseNum || 0;
        if (num1 < num2) return -1;
        if (num1 > num2) return 1;
    }
    
    return 0;
}