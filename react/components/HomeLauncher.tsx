import React, { useState } from "react";
import Button from "./ui/Button";
import Tooltip from "./ui/Tooltip";
import { ZapIcon, BookSearchIcon, LayersIcon, HighlighterIcon } from "./icons/icons";
import CategoryPanel from "./CategoryPanel";
import { ActionCategory } from "../types/actions";

type CategoryId = "actions" | "research" | "organize" | "annotate";

interface CategoryDef {
    id: CategoryId;
    label: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** The skill category, or `null` for the uncategorized "Actions" bucket. */
    category: ActionCategory | null;
    /** Tooltip: short value line + concrete examples of what lives in this bucket. */
    tooltipTitle: string;
    tooltipDescription: string;
}

const CATEGORIES: CategoryDef[] = [
    {
        id: "actions", label: "Actions", icon: ZapIcon, category: null,
        tooltipTitle: "General-purpose actions",
        tooltipDescription: "Summarize a paper, review a note, and other one-off prompts",
    },
    {
        id: "research", label: "Research", icon: BookSearchIcon, category: "research",
        tooltipTitle: "Find and connect sources",
        tooltipDescription: "Find similar papers, check references, spot gaps in your library",
    },
    {
        id: "organize", label: "Organize", icon: LayersIcon, category: "organize",
        tooltipTitle: "Keep your library tidy",
        tooltipDescription: "Auto-tag items, sort into collections, fix missing metadata",
    },
    {
        id: "annotate", label: "Annotate", icon: HighlighterIcon, category: "annotate",
        tooltipTitle: "Highlight while you read",
        tooltipDescription: "Skim papers and mark key findings as annotations",
    },
];

/**
 * HomePage launcher shown under the input area. Category is a partition: each
 * action lives in exactly one bucket, so "Actions" holds the uncategorized
 * actions and each skill button holds its own. The selected tab is sticky —
 * changing the Zotero selection updates the actions listed inside the open
 * panel (via CategoryPanel), but never switches the tab.
 */
const HomeLauncher: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
    // Sticky tab — only the user changes it. `null` = collapsed.
    const [expanded, setExpanded] = useState<CategoryId | null>("actions");

    const toggle = (id: CategoryId) => setExpanded((prev) => (prev === id ? null : id));
    const activeCategory = CATEGORIES.find((c) => c.id === expanded)?.category ?? null;

    return (
        <div className="display-flex flex-col gap-4 py-1" style={style}>
            {/* Category row — always visible */}
            <div className="display-flex flex-row flex-wrap gap-15 items-center justify-center">
                {CATEGORIES.map((cat) => {
                    const isActive = expanded === cat.id;
                    return (
                        <Tooltip
                            key={cat.id}
                            content={cat.tooltipTitle}
                            padding={false}
                            width="210px"
                            customContent={
                                <div className="px-2 py-1 display-flex flex-col gap-1">
                                    <span className="text-base font-color-secondary font-medium">{cat.tooltipTitle}</span>
                                    <span className="text-sm font-color-tertiary">{cat.tooltipDescription}</span>
                                </div>
                            }
                        >
                            <Button
                                variant={isActive ? "surface" : "outline"}
                                icon={cat.icon}
                                onClick={() => toggle(cat.id)}
                                aria-pressed={isActive}
                                className="flex-shrink-0"
                                style={{ padding: "4px 8px", borderRadius: "6px" }}
                            >
                                <span className="font-medium">{cat.label}</span>
                            </Button>
                        </Tooltip>
                    );
                })}
            </div>

            {/* Expanded panel for the active bucket */}
            {expanded !== null && <CategoryPanel category={activeCategory} />}
        </div>
    );
};

export default HomeLauncher;
