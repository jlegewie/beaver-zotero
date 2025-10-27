import { PopupMessageFeature } from '../types/popupMessage';

export interface VersionUpdateMessageConfig {
    version: string;
    title: string;
    text?: string;
    featureList: PopupMessageFeature[];
    learnMoreUrl?: string;
    learnMoreLabel?: string;
}

const compareVersions = (v1: string, v2: string): number => {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const len = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < len; i++) {
        const p1 = parts1[i] ?? 0;
        const p2 = parts2[i] ?? 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
};

const versionUpdateMessageList: VersionUpdateMessageConfig[] = [
    {
        version: "0.5.0",
        title: "Beaver Version 0.5.0",
        text: "Bug fixes and stability, support for group libraries and annotation tool.",
        featureList: [
            {
                title: "Support for group libraries",
                description: "You can sync Group Libraries with Beaver.",
            },
            {
                title: "Beaver can now annotate your PDFs",
                description: "Beaver can highlight and add notes to your PDFs.",
            },
            {
                title: "Bug fixes and improved stability",
                description: "Resolved a wide range of reliability issues.",
            }
        ],
        learnMoreUrl: "https://www.beaverapp.ai/changelog/v0.5",
        learnMoreLabel: "Learn more",
    },
    {
        version: "0.6.0",
        title: "Beaver Version 0.6.0",
        text: "New agent, improved metadata search and increased page balance.",
        featureList: [
            {
                title: "Agent 2.0",
                description: "A new agent that is more powerful, efficient and paves the way for future improvements.",
            },
            {
                title: "Improved metadata search",
                description: "Beaver can now search your library by publication title and filter results by year.",
            },
            {
                title: "Increased page balance to 125,000 pages",
                description: "Beta users can now process up to 125k pages for free. Additional files will be processed when you submit a chat query.",
            }
        ],
        // learnMoreUrl: "https://www.beaverapp.ai/changelog/v0.5",
        // learnMoreLabel: "Learn more",
    },
];

versionUpdateMessageList.sort((a, b) => compareVersions(a.version, b.version));

const versionUpdateMessageMap = versionUpdateMessageList.reduce<Record<string, VersionUpdateMessageConfig>>((acc, config) => {
    acc[config.version] = config;
    return acc;
}, {});

export const getVersionUpdateMessageConfig = (version: string): VersionUpdateMessageConfig | undefined => {
    return versionUpdateMessageMap[version];
};

export const getAllVersionUpdateMessageVersions = (): string[] => {
    return versionUpdateMessageList.map((config) => config.version);
};
