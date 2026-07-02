import React, { useState, useEffect, useRef, useCallback } from "react";
import { Action, ActionCategory, ActionTargetType, CATEGORY_LABELS, TARGET_TYPE_LABELS, TARGET_TYPE_DESCRIPTIONS } from "../../types/actions";
import { hasUserInputVariables } from "../../utils/userInputVariables";
import Button from "../ui/Button";
import MenuButton from "../ui/MenuButton";
import Tooltip from "../ui/Tooltip";
import { MenuItem } from "../ui/menu/ContextMenu";
import {
    Icon,
    ArrowDownIcon,
    ZapIcon,
    BookSearchIcon,
    LayersIcon,
    HighlighterIcon,
    InformationCircleIcon,
    DeleteIcon,
    UndoIcon,
} from "../icons/icons";

const MAX_TITLE_LENGTH = 45;
const MAX_PROMPT_TEXT_LENGTH = 2250;

const TARGET_TYPE_OPTIONS: ActionTargetType[] = ["global", "items", "attachment", "note", "collection"];
const CATEGORY_OPTIONS: (ActionCategory | undefined)[] = [undefined, "research", "organize", "annotate"];

// Category icons mirror the homepage launcher so the picker matches what users
// see there. Uncategorized actions fall under the general "Actions" bucket (Zap).
const CATEGORY_ICONS: Record<ActionCategory, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    research: BookSearchIcon,
    organize: LayersIcon,
    annotate: HighlighterIcon,
};
const categoryIcon = (cat: ActionCategory | undefined): React.ComponentType<React.SVGProps<SVGSVGElement>> =>
    cat ? CATEGORY_ICONS[cat] : ZapIcon;

const categoryLabel = (cat: ActionCategory | undefined): string => (cat ? CATEGORY_LABELS[cat] : "Uncategorized");
const categoryHelp = (cat: ActionCategory | undefined): string =>
    cat ? `Shown under the ${CATEGORY_LABELS[cat]} group.` : "Shown in the general Actions group.";

/** Field heading with a hover-info circle, matching the two-column edit layout. */
const FieldLabel: React.FC<{ label: string; tooltip: string }> = ({ label, tooltip }) => (
    <div className="action-field-label text-base font-color-primary">
        <span>{label}</span>
        <Tooltip content={tooltip} width="220px">
            <Icon icon={InformationCircleIcon} size={13} className="font-color-tertiary" />
        </Tooltip>
    </div>
);

interface ActionCardProps {
    action: Action;
    onChange: (updatedAction: Action) => void;
    onRemove: () => void;
    onHide?: () => void;
    onResetToDefault?: () => void;
    isBuiltin: boolean;
    isOverridden: boolean;
    hasBorder?: boolean;
    /** Externally requested edit mode (e.g. an action pill in the chat input
     *  was clicked): the card scrolls into view, enters edit mode, and calls
     *  `onForceEditHandled` to acknowledge the one-shot request. */
    forceEdit?: boolean;
    onForceEditHandled?: () => void;
}

const ActionCard: React.FC<ActionCardProps> = ({
    action,
    onChange,
    onRemove,
    onHide,
    onResetToDefault,
    isBuiltin,
    isOverridden,
    hasBorder = false,
    forceEdit = false,
    onForceEditHandled,
}) => {
    const [isEditing, setIsEditing] = useState(() => !action.title && !action.text);
    const [editTitle, setEditTitle] = useState(action.title);
    const [editText, setEditText] = useState(action.text);
    const [editTargetType, setEditTargetType] = useState<ActionTargetType>(action.targetType);
    const [editCategory, setEditCategory] = useState<ActionCategory | undefined>(action.category);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const titleInputRef = useRef<HTMLInputElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const previousActionRef = useRef(action);

    // Ref to hold latest draft values so the click-outside listener doesn't re-register on every keystroke
    const draftRef = useRef({ editTitle, editText, editTargetType, editCategory });
    useEffect(() => {
        draftRef.current = { editTitle, editText, editTargetType, editCategory };
    }, [editTitle, editText, editTargetType, editCategory]);

    // Sync local draft state when action changes
    useEffect(() => {
        const actionSwitched = previousActionRef.current !== action;
        if (actionSwitched || !isEditing) {
            setEditTitle(action.title);
            setEditText(action.text);
            setEditTargetType(action.targetType);
            setEditCategory(action.category);
        }
        previousActionRef.current = action;
    }, [action, action.title, action.text, action.targetType, action.category, isEditing]);

    // Close edit mode on click outside — auto-saves, or removes if the action is empty
    useEffect(() => {
        if (!isEditing) return;
        const doc = cardRef.current?.ownerDocument;
        if (!doc) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
                const { editTitle: title, editText: text, editTargetType: targetType, editCategory: category } = draftRef.current;
                // New action that's still empty — remove it
                if (!title && !text && !action.title && !action.text) {
                    onRemove();
                } else {
                    // Auto-save current draft
                    onChange({ ...action, title, text, targetType, category });
                }
                setIsEditing(false);
            }
        };

        doc.addEventListener("mousedown", handleClickOutside);
        return () => doc.removeEventListener("mousedown", handleClickOutside);
    }, [isEditing, action, onChange, onRemove]);

    // Focus title input when entering edit mode
    useEffect(() => {
        if (isEditing) {
            requestAnimationFrame(() => {
                if (titleInputRef.current) {
                    titleInputRef.current.focus();
                    titleInputRef.current.selectionStart = titleInputRef.current.value.length;
                    titleInputRef.current.selectionEnd = titleInputRef.current.value.length;
                }
            });
        }
    }, [isEditing]);

    // Auto-resize textarea when content changes
    useEffect(() => {
        if (isEditing && textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    }, [editText, isEditing]);

    const handleEnterEdit = useCallback(() => {
        if (!isEditing) {
            setEditTitle(action.title);
            setEditText(action.text);
            setEditTargetType(action.targetType);
            setEditCategory(action.category);
            setIsEditing(true);
        }
    }, [isEditing, action]);

    // Externally requested edit mode: reveal the card, open the editor, and
    // acknowledge so the request isn't reapplied on remount.
    useEffect(() => {
        if (!forceEdit) return;
        handleEnterEdit();
        cardRef.current?.scrollIntoView({ block: 'center' });
        onForceEditHandled?.();
    }, [forceEdit, handleEnterEdit, onForceEditHandled]);

    const handleCancel = useCallback(() => {
        if (!action.title && !action.text) {
            onRemove();
        }
        setEditTitle(action.title);
        setEditText(action.text);
        setEditTargetType(action.targetType);
        setEditCategory(action.category);
        setIsEditing(false);
    }, [action, onRemove]);

    const handleSave = useCallback(() => {
        onChange({
            ...action,
            title: editTitle,
            text: editText,
            targetType: editTargetType,
            category: editCategory,
        });
        setIsEditing(false);
    }, [action, editTitle, editText, editTargetType, editCategory, onChange]);

    const targetTypeMenuItems: MenuItem[] = TARGET_TYPE_OPTIONS.map(tt => ({
        label: TARGET_TYPE_LABELS[tt],
        onClick: () => setEditTargetType(tt),
        customContent: (
            <div className="display-flex flex-col">
                <span className="text-sm font-color-primary">{TARGET_TYPE_LABELS[tt]}</span>
                <span className="text-sm font-color-secondary">{TARGET_TYPE_DESCRIPTIONS[tt]}</span>
            </div>
        )
    }));

    const categoryMenuItems: MenuItem[] = CATEGORY_OPTIONS.map(cat => ({
        label: categoryLabel(cat),
        onClick: () => setEditCategory(cat),
        customContent: (
            <div className="display-flex flex-row items-center gap-2 w-full min-w-0">
                <Icon icon={categoryIcon(cat)} size={14} className="font-color-secondary flex-shrink-0" />
                <span className="flex-1 truncate text-sm font-color-primary">{categoryLabel(cat)}</span>
            </div>
        )
    }));

    // --- View mode ---
    if (!isEditing) {
        return (
            <div
                ref={cardRef}
                className={`action-card ${hasBorder ? 'border-top-popup' : ''}`}
                onClick={handleEnterEdit}
            >
                <div className="display-flex flex-col flex-1 min-w-0" style={{ gap: '3px' }}>
                    <div className="display-flex flex-row items-center gap-3">
                        <div className="font-color-primary text-base font-medium">
                            {action.title || <span className="font-color-tertiary">Untitled action</span>}
                        </div>
                        <span className="action-target-badge" data-type={action.targetType}>
                            {TARGET_TYPE_LABELS[action.targetType]}
                        </span>
                        {hasUserInputVariables(action.text) && (
                            <Tooltip content="This prompt contains [[ ]] placeholders, which are sent as written." width="220px">
                                <span className="action-target-badge" data-type="placeholder">
                                    Placeholders
                                </span>
                            </Tooltip>
                        )}
                    </div>
                    {action.text && (
                        <div className="font-color-secondary text-base action-card-preview">
                            {action.text}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // --- Edit mode ---
    return (
        <div ref={cardRef} className={`action-card action-card-editing ${hasBorder ? 'border-top-popup' : ''}`}>
            {/* Header bar — distinct background, no leading icon, primary actions on the right */}
            <div className="action-edit-header">
                <div className="text-base font-color-secondary truncate min-w-0">
                    Editing action:{' '}
                    <span className="font-semibold font-color-primary">{editTitle.trim() || "New action"}</span>
                </div>
                <div className="display-flex flex-row items-center gap-2 flex-shrink-0">
                    <Button
                        type="button"
                        variant="outline"
                        style={{ padding: '3px 12px' }}
                        onClick={handleCancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="solid"
                        style={{ padding: '3px 12px' }}
                        onClick={handleSave}
                    >
                        Save
                    </Button>
                </div>
            </div>

            <div className="action-edit-body">
                {/* Name */}
                <div className="action-field-label text-base font-color-primary font-semibold">Name</div>
                <div className="action-field-box">
                    <input
                        ref={titleInputRef}
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        placeholder="Action name..."
                        aria-label="Action name"
                        maxLength={MAX_TITLE_LENGTH}
                        className="action-field-control text-base font-medium"
                    />
                </div>

                {/* Prompt */}
                <div className="action-field-label text-base font-color-primary font-semibold mt-3">Prompt</div>
                <div className="action-field-box">
                    <textarea
                        ref={textareaRef}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onInput={(e) => {
                            e.currentTarget.style.height = "auto";
                            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                        }}
                        placeholder="Enter prompt text..."
                        aria-label="Action prompt text"
                        maxLength={MAX_PROMPT_TEXT_LENGTH}
                        className="action-field-control action-edit-textarea text-base"
                        rows={3}
                    />
                </div>
                {hasUserInputVariables(editText) && (
                    <div className="action-field-help text-sm font-color-tertiary display-flex flex-row gap-2 items-start">
                        <Icon icon={InformationCircleIcon} size={13} className="flex-shrink-0" style={{ marginTop: '2px' }} />
                        <span>
                            This prompt contains [[ ]] placeholders. They are currently sent to the
                            assistant as written; a new way to fill them in is coming in a future update.
                        </span>
                    </div>
                )}

                {/* Applies to + Category — two outlined pickers side by side */}
                <div className="display-flex flex-row gap-4 mt-3">
                    <div className="display-flex flex-col flex-1 min-w-0">
                        <FieldLabel
                            label="Applies to"
                            tooltip="Controls when this action shows up, based on your current Zotero selection."
                        />
                        <MenuButton
                            menuItems={targetTypeMenuItems}
                            variant="outline"
                            ariaLabel="Select what this action applies to"
                            className="action-field-select"
                            customContent={
                                <div className="display-flex flex-row items-center gap-2 w-full min-w-0">
                                    <span className="flex-1 truncate text-base font-color-primary">{TARGET_TYPE_LABELS[editTargetType]}</span>
                                    <Icon icon={ArrowDownIcon} size={14} className="font-color-tertiary flex-shrink-0" />
                                </div>
                            }
                        />
                        <div className="action-field-help text-sm font-color-tertiary">
                            {TARGET_TYPE_DESCRIPTIONS[editTargetType]}
                        </div>
                    </div>

                    <div className="display-flex flex-col flex-1 min-w-0">
                        <FieldLabel
                            label="Category"
                            tooltip="Groups this action on the Beaver homepage launcher."
                        />
                        <MenuButton
                            menuItems={categoryMenuItems}
                            variant="outline"
                            ariaLabel="Select category"
                            className="action-field-select"
                            customContent={
                                <div className="display-flex flex-row items-center gap-2 w-full min-w-0">
                                    <Icon icon={categoryIcon(editCategory)} size={14} className="font-color-secondary flex-shrink-0" />
                                    <span className="flex-1 truncate text-base font-color-primary">{categoryLabel(editCategory)}</span>
                                    <Icon icon={ArrowDownIcon} size={14} className="font-color-tertiary flex-shrink-0" />
                                </div>
                            }
                        />
                        <div className="action-field-help text-sm font-color-tertiary">
                            {categoryHelp(editCategory)}
                        </div>
                    </div>
                </div>

                {/* Secondary actions — Delete always sits bottom-left. For a built-in,
                    "Delete" hides it (built-ins are defined in code and can't be truly
                    removed); it stays restorable from the Deleted actions list. Reset to
                    default (edited built-ins only) sits bottom-right. */}
                <div className="display-flex flex-row flex-1 items-center gap-2 px-2 pt-2">
                    <div className="flex-1"></div>
                    {isBuiltin && isOverridden && onResetToDefault && (
                        <>
                            <Button
                                variant="outline"
                                icon={UndoIcon}
                                style={{ padding: "3px 8px" }}
                                // Reset persists immediately (the override is cleared) and
                                // re-merges the default action; the draft-sync effect refreshes
                                // the fields, so we stay in edit mode showing the restored values.
                                onClick={(e) => { e.stopPropagation(); onResetToDefault(); }}
                            >
                                Reset to default
                            </Button>
                        </>
                    )}
                    <Button
                        variant="error"
                        icon={DeleteIcon}
                        iconClassName="font-color-red"
                        style={{ padding: "3px 8px" }}
                        onClick={(e) => { e.stopPropagation(); (isBuiltin ? onHide : onRemove)?.(); setIsEditing(false); }}
                    >
                        <span className="font-color-red">Delete</span>
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default ActionCard;
