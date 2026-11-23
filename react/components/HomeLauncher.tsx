import React, { useLayoutEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import Button from "@beaver/agent-ui/primitives/Button";
import Tooltip from "@beaver/agent-ui/primitives/Tooltip";
import { QuillWriteIcon, BookSearchIcon, LayersIcon, HighlighterIcon } from "./icons/icons";
import CategoryPanel from "./CategoryPanel";
import { ActionCategory } from "@beaver/agent-core/types/actions";
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

/** Layout of the category buttons, chosen by the launcher's width (see beaver.css). */
type LauncherSize = "narrow" | "compact" | "wide" | "spacious";

/**
 * Picks the button layout from the launcher's width in rem, the unit the button
 * sizes use, so the steps hold whatever the root font size is.
 */
function measureLauncherSize(element: HTMLElement): LauncherSize {
    const { documentElement: root, defaultView: win } = element.ownerDocument;
    const rootFontSize = (root && win && parseFloat(win.getComputedStyle(root)?.fontSize ?? "")) || 16;
    const width = element.clientWidth / rootFontSize;
    if (width < 25.5) return "narrow";
    if (width >= 44) return "spacious";
    if (width >= 30) return "wide";
    return "compact";
}

/**
 * Tracks the launcher's layout as it resizes. A ResizeObserver rather than a CSS
 * container query: before Firefox 133, `container-type` made the launcher the
 * containing block of its `position: fixed` tooltips, which then render offset.
 */
function useLauncherSize(ref: React.RefObject<HTMLElement | null>): LauncherSize {
    const [size, setSize] = useState<LauncherSize>("compact");
    useLayoutEffect(() => {
        const element = ref.current;
        const ResizeObserverCtor = element?.ownerDocument.defaultView?.ResizeObserver;
        if (!element || !ResizeObserverCtor) return;
        const update = () => setSize(measureLauncherSize(element));
        update();
        const observer = new ResizeObserverCtor(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

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
    const rootRef = useRef<HTMLDivElement>(null);
    const size = useLauncherSize(rootRef);

    const toggle = (id: CategoryId) => setExpanded((prev) => (prev === id ? null : id));
    const activeCategory = CATEGORIES.find((c) => c.id === expanded)?.category ?? null;

    return (
        <div ref={rootRef} className="home-launcher display-flex flex-col gap-4 py-1" data-size={size} style={style}>
            {/* Category row — always visible */}
            <div className="home-launcher-row">
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
                                className="home-launcher-button"
                                iconClassName="flex-shrink-0 scale-11"
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
