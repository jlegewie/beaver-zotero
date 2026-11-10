import React from "react";
import { Icon, LayersIcon, MagicWandIcon, PlayIcon, PlusSignIcon, TableIcon, TickIcon } from "../../icons";

export interface EmptyTableGuideProps {
    /** The host's Add items control (the + Items menu); absent, that step names the drop only. */
    addItems?: React.ReactNode;
    /** Opens the column editor; absent, the table already has columns and the step is left out. */
    onAddColumn?(): void;
    /** Why a column cannot be added now (the table's limits). */
    addColumnDisabledReason?: string;
    /** Opens Beaver's chat on this table; absent, that step is left out. */
    onAskBeaver?(): void;
    /** Whether the toolbar has a Fill button to name in the closing line. */
    canFill?: boolean;
    /**
     * The table's items, once it has some: the items step shows as done and
     * the guide sits beside the rows rather than in their place.
     */
    itemCount?: number;
}

interface Step {
    key: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    title: string;
    text: React.ReactNode;
    action: React.ReactNode;
    done?: boolean;
}

/**
 * How to start a table, each step with the control and icon the toolbar uses
 * for the same thing (the sources chip, + Items, + Column, Beaver's wand and
 * Fill), so the guide also teaches the toolbar. A table with no rows shows it
 * where its rows would be; a table with rows but no question shows it beside
 * them, with the items step done.
 */
export function EmptyTableGuide({
    addItems,
    onAddColumn,
    addColumnDisabledReason,
    onAskBeaver,
    canFill,
    itemCount = 0,
}: EmptyTableGuideProps): React.ReactElement {
    const hasItems = itemCount > 0;
    const steps: Step[] = [
        hasItems
            ? {
                  key: "items",
                  icon: TickIcon,
                  title: itemCount === 1 ? "1 item added" : `${itemCount.toLocaleString("en-US")} items added`,
                  text: (
                      <>
                          Each item is a row. Add more with{" "}
                          <span className="rt-nowrap">
                              <Icon icon={PlusSignIcon} size={11} className="rt-empty-inline-icon" /> Items
                          </span>
                          , or drag them onto the table.
                      </>
                  ),
                  action: null,
                  done: true,
              }
            : {
                  key: "items",
                  icon: LayersIcon,
                  title: "Add items",
                  text: "Each item from your library is a row. Drag items, a collection or a tag onto the table, or pick them.",
                  action: addItems ?? null,
              },
    ];
    if (onAddColumn)
        steps.push({
            key: "columns",
            icon: TableIcon,
            title: "Add columns",
            text: "Each column is a question Beaver answers for every item: as text, yes / no or a category.",
            action: (
                // A disabled button shows no tooltip of its own.
                <span title={addColumnDisabledReason}>
                    <button
                        type="button"
                        className="rt-empty-action"
                        disabled={!!addColumnDisabledReason}
                        onClick={onAddColumn}
                    >
                        <Icon icon={PlusSignIcon} size={13} />
                        <span>Column</span>
                    </button>
                </span>
            ),
        });
    if (onAskBeaver)
        steps.push({
            key: "ask",
            icon: MagicWandIcon,
            title: "Ask Beaver",
            text: hasItems
                ? "Describe what you want to compare. Beaver suggests columns for these items."
                : onAddColumn
                  ? "Describe what you want to compare. Beaver finds the items and suggests the columns."
                  : "Describe the items you want to compare. Beaver finds them for you.",
            action: (
                <button type="button" className="rt-empty-action" onClick={onAskBeaver}>
                    <Icon icon={MagicWandIcon} size={13} />
                    <span>Ask Beaver</span>
                </button>
            ),
        });

    return (
        <div className={`rt-empty-guide${hasItems ? " rt-empty-guide-beside" : ""}`} data-empty-table-guide="">
            <div className="rt-empty-guide-inner">
                <h2 className="rt-empty-guide-title">Start your table</h2>
                <ul className="rt-empty-steps">
                    {steps.map((step) => (
                        <li
                            key={step.key}
                            className={`rt-empty-step${step.done ? " rt-empty-step-done" : ""}`}
                            data-step={step.key}
                        >
                            <span className="rt-empty-step-icon" aria-hidden="true">
                                <Icon icon={step.icon} size={16} />
                            </span>
                            <div className="rt-empty-step-body">
                                <span className="rt-empty-step-title">{step.title}</span>
                                <span className="rt-empty-step-text">{step.text}</span>
                            </div>
                            {step.action ? <div className="rt-empty-step-action">{step.action}</div> : null}
                        </li>
                    ))}
                </ul>
                {canFill ? (
                    <p className="rt-empty-guide-foot">
                        Then <Icon icon={PlayIcon} size={12} className="rt-empty-inline-icon" /> Fill has Beaver answer
                        every cell.
                    </p>
                ) : null}
            </div>
        </div>
    );
}
