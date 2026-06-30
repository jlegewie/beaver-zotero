import React, { useState } from "react";
import Button from "./ui/Button";
import { ZapIcon, BookSearchIcon, LayersIcon, HighlighterIcon } from "./icons/icons";
import ActionSuggestions from "./ActionSuggestions";

type CategoryId = "actions" | "research" | "organize" | "annotate";

interface CategoryDef {
    id: CategoryId;
    label: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

const CATEGORIES: CategoryDef[] = [
    { id: "actions", label: "Actions", icon: ZapIcon },
    { id: "research", label: "Research", icon: BookSearchIcon },
    { id: "organize", label: "Organize", icon: LayersIcon },
    { id: "annotate", label: "Annotate", icon: HighlighterIcon },
];

/**
 * Placeholder body for categories that are not built out yet. The launcher,
 * the category row, and the expand/collapse behavior are complete; the
 * Research, Organize, and Annotate buckets are filled in later.
 */
const CategoryPlaceholder: React.FC<{ label: string }> = ({ label }) => (
    <div className="font-color-tertiary text-sm text-center px-2 py-3">
        {label} is coming soon.
    </div>
);

/**
 * HomePage launcher shown under the input area: a row of category buttons that
 * each expand a panel of options. Only one category is open at a time. The
 * "Actions" category is open on load and reveals the context-aware action
 * suggestions (which update live as the Zotero selection changes), with the
 * target item shown at the bottom of the panel.
 */
const HomeLauncher: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
    // Default to the "Actions" panel open so the context-aware suggestions are
    // visible and update live as the Zotero selection changes (collapsing it
    // would hide that live list until the user re-opens it).
    const [expanded, setExpanded] = useState<CategoryId | null>("actions");

    const toggle = (id: CategoryId) =>
        setExpanded((prev) => (prev === id ? null : id));

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

            {/* Expanded panel for the active category */}
            {expanded === "actions" && (
                <ActionSuggestions variant="panel" showGlobal={false} />
            )}
            {expanded === "research" && <CategoryPlaceholder label="Research" />}
            {expanded === "organize" && <CategoryPlaceholder label="Organize" />}
            {expanded === "annotate" && <CategoryPlaceholder label="Annotate" />}
        </div>
    );
};

export default HomeLauncher;
