type ParsedVersion = {
    parts: number[];
    prerelease: string[];
};

/**
 * Parse a semantic version string into comparable release and prerelease parts.
 */
function parseVersion(version: string): ParsedVersion {
    const [withoutBuildMetadata] = version.trim().split('+', 1);
    const prereleaseStart = withoutBuildMetadata.indexOf('-');
    const main = prereleaseStart === -1
        ? withoutBuildMetadata
        : withoutBuildMetadata.slice(0, prereleaseStart);
    const prerelease = prereleaseStart === -1
        ? ''
        : withoutBuildMetadata.slice(prereleaseStart + 1);

    return {
        parts: main.split('.').map((part) => {
            const parsed = Number.parseInt(part, 10);
            return Number.isFinite(parsed) ? parsed : 0;
        }),
        prerelease: prerelease ? prerelease.split('.') : [],
    };
}

/**
 * Compare semantic version strings, including prerelease versions.
 */
export function compareVersions(v1: string, v2: string): number {
    const parsed1 = parseVersion(v1);
    const parsed2 = parseVersion(v2);
    const maxLength = Math.max(parsed1.parts.length, parsed2.parts.length);

    for (let i = 0; i < maxLength; i++) {
        const part1 = parsed1.parts[i] ?? 0;
        const part2 = parsed2.parts[i] ?? 0;

        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }

    if (!parsed1.prerelease.length && !parsed2.prerelease.length) return 0;
    if (!parsed1.prerelease.length) return 1;
    if (!parsed2.prerelease.length) return -1;

    const prereleaseLength = Math.max(parsed1.prerelease.length, parsed2.prerelease.length);
    for (let i = 0; i < prereleaseLength; i++) {
        const identifier1 = parsed1.prerelease[i];
        const identifier2 = parsed2.prerelease[i];

        if (identifier1 === undefined) return -1;
        if (identifier2 === undefined) return 1;
        if (identifier1 === identifier2) continue;

        const number1 = /^\d+$/.test(identifier1) ? Number.parseInt(identifier1, 10) : null;
        const number2 = /^\d+$/.test(identifier2) ? Number.parseInt(identifier2, 10) : null;

        if (number1 !== null && number2 !== null) {
            if (number1 > number2) return 1;
            if (number1 < number2) return -1;
            continue;
        }

        if (number1 !== null) return -1;
        if (number2 !== null) return 1;

        return identifier1 > identifier2 ? 1 : -1;
    }

    return 0;
}
