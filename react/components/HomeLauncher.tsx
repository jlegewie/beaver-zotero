import React, { useState } from "react";
import Button from "./ui/Button";
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
}

const CATEGORIES: CategoryDef[] = [
    { id: "actions", label: "Actions", icon: ZapIcon, category: null },
    { id: "research", label: "Research", icon: BookSearchIcon, category: "research" },
    { id: "organize", label: "Organize", icon: LayersIcon, category: "organize" },
    { id: "annotate", label: "Annotate", icon: HighlighterIcon, category: "annotate" },
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
                        <Button
                            key={cat.id}
                            variant={isActive ? "surface" : "outline"}
                            icon={cat.icon}
                            onClick={() => toggle(cat.id)}
                            aria-pressed={isActive}
                            className="flex-shrink-0"
                            style={{ padding: "4px 8px", borderRadius: "6px" }}
                        >
                            <span className="font-medium">{cat.label}</span>
                        </Button>
                    );
                })}
            </div>

            {/* Expanded panel for the active bucket */}
            {expanded !== null && <CategoryPanel category={activeCategory} />}
        </div>
    );
};

export default HomeLauncher;
