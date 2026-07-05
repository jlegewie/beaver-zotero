import React from "react";
import { useAtom } from "jotai";
import Button from "./ui/Button";
import Tooltip from "./ui/Tooltip";
import { QuillWriteIcon, BookSearchIcon, LayersIcon, HighlighterIcon } from "./icons/icons";
import CategoryPanel from "./CategoryPanel";
import { ActionCategory } from "../types/actions";
import { homeLauncherCategoryAtom, HomeLauncherCategoryId } from "../atoms/ui";

type CategoryId = HomeLauncherCategoryId;

interface CategoryDef {
    id: CategoryId;
    label: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** The skill category this launcher button maps to. */
    category: ActionCategory;
    /** Tooltip: short value line + concrete examples of what lives in this bucket. */
    tooltipTitle: string;
    tooltipDescription: string;
}

const CATEGORIES: CategoryDef[] = [
    {
        id: "research", label: "Research", icon: BookSearchIcon, category: "research",
        tooltipTitle: "Ask and explore your library",
        tooltipDescription: "Grounded answers from full text, plus related work and gaps",
    },
    {
        id: "write", label: "Write", icon: QuillWriteIcon, category: "write",
        tooltipTitle: "Write & synthesize",
        tooltipDescription: "Summaries, reviews, and notes drawn from your sources — every claim cited",
    },
    {
        id: "organize", label: "Organize", icon: LayersIcon, category: "organize",
        tooltipTitle: "Organize & edit your library",
        tooltipDescription: "Tag, sort, and fix metadata. You approve every change",
    },
    {
        id: "annotate", label: "Annotate", icon: HighlighterIcon, category: "annotate",
        tooltipTitle: "AI-powered PDF annotations",
        tooltipDescription: "Highlights and notes added right in your PDF, ready to review",
    },
];

/**
 * HomePage launcher shown under the input area. Category is a partition: each
 * action lives in exactly one skill bucket (Research / Write / Organize /
 * Annotate). Actions with no category are not surfaced here — they stay
 * available from the slash menu. Changing the Zotero selection updates the
 * actions listed inside the open panel (via CategoryPanel), but never switches
 * the tab.
 */
const HomeLauncher: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
    // Only the user changes this while the UI is mounted. `null` = collapsed.
    // The shared atom keeps library and reader sidebars in sync.
    const [expanded, setExpanded] = useAtom(homeLauncherCategoryAtom);

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
                                    <span className="text-sm font-color-secondary">{cat.tooltipDescription}</span>
                                </div>
                            }
                        >
                            <Button
                                variant={isActive ? "surface" : "outline"}
                                icon={cat.icon}
                                onClick={() => toggle(cat.id)}
                                aria-pressed={isActive}
                                iconClassName="flex-shrink-0 scale-11"
                                style={{ padding: "4px 7px", borderRadius: "6px" }}
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
