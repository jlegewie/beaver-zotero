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
    },
    {
        version: "0.7.0",
        title: "Beaver Version 0.7.0",
        text: "Support for tags and collections and other improvements.",
        featureList: [
            {
                title: "Support for tags and collections",
                description: "Using the @ menu, you can now filter by tags and collections to restrict Beaver searches.",
            },
            {
                title: "Improved handeling of user attachments",
            }
        ],
        learnMoreUrl: "mailto:contact@beaverapp.ai?subject=Beaver Feedback",
        learnMoreLabel: "Give Feedback",
    },
    {
        version: "0.7.3",
        title: "Beaver Version 0.7.3",
        featureList: [
            {
                title: "Under the hood improvements to annotation tools",
                description: "The annotation tool was rewritten. Please report any issues you encounter.",
            },
            {
                title: "Consistent Beaver UI between library and reader",
                description: "The Beaver UI is now consistent when switching between the Zotero library and file reader."
            }
        ]
    },
    {
        version: "0.7.9",
        title: "Beaver Version 0.7.9",
        text: "Fixed appearance issues: Beaver now looks and behaves consistently across all systems and configurations.",
        featureList: []
    },
    {
        version: "0.8.0",
        title: "Beaver Version 0.8.0",
        text: "Search 250M+ scholarly works. Generate & save Zotero notes. And more...",
        featureList: [
            {
                title: "Search 250 million scholarly works",
                description: "A sub-agent searches by topic, author, or journal, and follows citation chains to surface new references and extend your Zotero library. <a href='https://www.beaverapp.ai/docs/web-search'>Learn more</a>",
            },
            {
                title: "Generate notes in a dedicated panel",
                description: "Beaver now writes notes in a separate panel that you can save as Zotero Notes or copy elsewhere. <a href='https://www.beaverapp.ai/docs/notes'>Learn more</a>",
            },
            {
                title: "New documentation site",
                description: "Beaver finally has <a href='https://www.beaverapp.ai/docs'>better documentation</a>.",
            }
        ],
        // learnMoreUrl: "https://www.beaverapp.ai/changelog/v0.8",
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
