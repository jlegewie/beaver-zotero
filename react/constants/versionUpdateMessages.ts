import { PopupMessageFeature } from '../types/popupMessage';

/**
 * Example prompt shown as a chat bubble in the feature tour
 */
export interface ExamplePrompt {
    /** The full text of the example prompt */
    text: string;
    /** Part of the text to highlight with accent color (must be substring of text) */
    highlight?: string;
    /** Position of the bubble - alternating creates a chat-like feel */
    position?: 'left' | 'right' | 'center';
}

/**
 * A single step/slide in the feature tour
 */
export interface FeatureStep {
    /** Title of this feature */
    title: string;
    /** Description text (supports HTML links) */
    description?: string;
    /** Example prompts shown as chat bubbles */
    examplePrompts?: ExamplePrompt[];
    /** URL to learn more about this feature */
    learnMoreUrl?: string;
}

export interface VersionUpdateMessageConfig {
    version: string;
    title: string;
    /** Subtitle/intro text shown on the first screen */
    subtitle?: string;
    /** @deprecated Use steps instead for new versions */
    text?: string;
    /** @deprecated Use steps instead for new versions */
    featureList?: PopupMessageFeature[];
    /** Feature steps for the guided tour (new format) */
    steps?: FeatureStep[];
    learnMoreUrl?: string;
    learnMoreLabel?: string;
    footer?: string;
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
    {
        version: "0.9.0",
        title: "Beaver Version 0.9.0",
        text: "New research agent, flexible window mode, and more",
        featureList: [
            {
                title: "New Research Agent",
                description: "Upgraded to a more powerful agent. This is a major change so please reach out with any feedback or problems!",
            },
            {
                title: "Flexible Window Mode",
                description: "In addition to the Zotero sidebar, you can now open Beaver in its own separate window.",
            },
            {
                title: "Better Message Controls",
                description: "Edit and resubmit previous messages, resume interrupted conversations, and other handy improvements."
            }
        ]
    },
    {
        version: "0.9.4",
        title: "Beaver Version 0.9.4",
        featureList: [
            {
                title: "Copy text with keyboard shortcut (cmd/ctrl+c)",
            },
            {
                title: "Use keyboard shortcut to open Beaver in separate window (cmd/ctrl+shift+l)",
            },
            {
                title: "Various bug fixes and improvements",
            }
        ],
        footer: "Full changelog <a href='https://github.com/jlegewie/beaver-zotero/releases/tag/v0.9.4' target='_blank'>here</a>."
    },
    {
        version: "0.10.0",
        title: "Beaver Version 0.10",
        text: "Version 0.10 introduces Beaver Free, ensuring the platform remains sustainable and available to everyone in the long term.",
        featureList: [
            {
                title: "Introducing Beaver Free",
                description: "This new tier supports core features without cloud costs. Going forward, all new users will start on this plan. Read more <a href='https://www.beaverapp.ai/docs/free-plan'>here</a>.",
            },
            {
                title: "Impact on existing accounts",
                description: "Active users remain on Pro (Beta). To manage server costs, only long-term inactive accounts are migrated to the Free plan. Read more <a href='https://www.beaverapp.ai/free-plan#what-does-this-mean-for-current-beta-users'>here</a>.",
            },
        ]
    },
    {
        version: "0.11.0",
        title: "New in Beaver 0.11",
        // subtitle: "Organize your library, edit metadata, and enjoy more efficient AI usage.",
        steps: [
            {
                title: "Organize Your Library",
                description: "Beaver can now create collections, add tags, and help you organize items in bulk. <a href='https://www.beaverapp.ai/docs/library-management'>Learn more →</a>",
                examplePrompts: [
                    {
                        text: "I added several papers this week. Organize them into appropriate collections based on their topics.",
                        highlight: "Organize them into appropriate collections",
                        position: "left"
                    },
                    {
                        text: "Find all unfiled papers and suggest which collections they belong in.",
                        highlight: "unfiled papers",
                        position: "right"
                    },
                    {
                        text: "I'm starting a literature review on ____. Create a collection and add all relevant papers from my library.",
                        highlight: "add all relevant papers",
                        position: "left"
                    }
                ],
            },
            {
                title: "Edit Item Metadata",
                description: "Fix incomplete metadata, add custom content like summaries to the extra field, and update bibliographic fields through natural conversation. <a href='https://www.beaverapp.ai/docs/editing-metadata'>Learn more →</a>",
                examplePrompts: [
                    {
                        text: "Review and fix metadata for all items I added today. Look up the correct information and fix any issues.",
                        highlight: "Review and fix metadata",
                        position: "left"
                    },
                    {
                        text: "Add the citation count to the extra field for all items that don't have it.",
                        highlight: "Add the citation count",
                        position: "right"
                    },
                    {
                        text: "Find all items with missing abstracts and create an abstract for them.",
                        highlight: "items with missing abstracts",
                        position: "left"
                    }
                ],
            },
            {
                title: "Tip: Use Custom Prompts for Common Tasks",
                description: "Save time by creating reusable prompts in Beaver settings for common library management tasks.\n\nRead about all changes in the <a href='https://github.com/jlegewie/beaver-zotero/releases/tag/v0.11.0'>change log</a>.",
            }
        ]
    },
    {
        version: "0.11.2",
        title: "Beaver Version 0.11.2",
        featureList: [
            {
                title: "Improved Metadata Editing",
                description: "Support for almost all metadata fields from creators to docket number, or podcast episode.",
            },
            {
                title: "Performance improvements and bug fixes",
                description: "Improved performance so that adding tags to 100+ items should be a breeze.",
            },
        ],
    },
    {
        version: "0.11.4",
        title: "Beaver Version 0.11.4",
        featureList: [
            {
                title: "Keyboard shortcut updated",
                description: "Toggle Beaver with ⌘J (Ctrl+J on Windows/Linux). Open in a separate window with ⌘⇧J (Ctrl+Shift+J on Windows/Linux).",
            },
        ],
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

/**
 * Check if a version config uses the new step-based tour format
 */
export const usesStepFormat = (config: VersionUpdateMessageConfig): boolean => {
    return !!(config.steps && config.steps.length > 0);
};
