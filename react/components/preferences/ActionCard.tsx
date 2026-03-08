import React, { useState, useEffect, useRef, useCallback } from "react";
import { Action, ActionTargetType, TARGET_TYPE_LABELS } from "../../types/actions";
import { CancelIcon } from "../icons/icons";
import IconButton from "../ui/IconButton";
import Button from "../ui/Button";
import MenuButton from "../ui/MenuButton";
import { MenuItem } from "../ui/menu/ContextMenu";

const MAX_TITLE_LENGTH = 45;
const MAX_PROMPT_TEXT_LENGTH = 2250;

// const TARGET_TYPE_OPTIONS: ActionTargetType[] = ["items", "attachment", "note", "collection", "global"];
const TARGET_TYPE_OPTIONS: ActionTargetType[] = ["items", "attachment", "collection", "global"];

interface ActionCardProps {
    action: Action;
    onChange: (updatedAction: Action) => void;
    onRemove: () => void;
    onHide?: () => void;
    onResetToDefault?: () => void;
    isBuiltin: boolean;
    isOverridden: boolean;
}

const ActionCard: React.FC<ActionCardProps> = ({
    action,
    onChange,
    onRemove,
    onHide,
    onResetToDefault,
    isBuiltin,
    isOverridden,
}) => {
    const [isEditing, setIsEditing] = useState(() => !action.title && !action.text);
    const [editTitle, setEditTitle] = useState(action.title);
    const [editText, setEditText] = useState(action.text);
    const [editTargetType, setEditTargetType] = useState<ActionTargetType>(action.targetType);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const titleInputRef = useRef<HTMLInputElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const previousActionRef = useRef(action);

    // Ref to hold latest draft values so the click-outside listener doesn't re-register on every keystroke
    const draftRef = useRef({ editTitle, editText, editTargetType });
    useEffect(() => {
        draftRef.current = { editTitle, editText, editTargetType };
    }, [editTitle, editText, editTargetType]);

    // Sync local draft state when action changes
    useEffect(() => {
        const actionSwitched = previousActionRef.current !== action;
        if (actionSwitched || !isEditing) {
            setEditTitle(action.title);
            setEditText(action.text);
            setEditTargetType(action.targetType);
        }
        previousActionRef.current = action;
    }, [action, action.title, action.text, action.targetType, isEditing]);

    // Close edit mode on click outside — auto-saves, or removes if the action is empty
    useEffect(() => {
        if (!isEditing) return;
        const doc = cardRef.current?.ownerDocument;
        if (!doc) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
                const { editTitle: title, editText: text, editTargetType: targetType } = draftRef.current;
                // New action that's still empty — remove it
                if (!title && !text && !action.title && !action.text) {
                    onRemove();
                } else {
                    // Auto-save current draft
                    onChange({ ...action, title, text, targetType });
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
            setIsEditing(true);
        }
    }, [isEditing, action]);

    const handleCancel = useCallback(() => {
        if (!action.title && !action.text) {
            onRemove();
        }
        setEditTitle(action.title);
        setEditText(action.text);
        setEditTargetType(action.targetType);
        setIsEditing(false);
    }, [action, onRemove]);

    const handleSave = useCallback(() => {
        onChange({
            ...action,
            title: editTitle,
            text: editText,
            targetType: editTargetType,
        });
        setIsEditing(false);
    }, [action, editTitle, editText, editTargetType, onChange]);

    const targetTypeMenuItems: MenuItem[] = TARGET_TYPE_OPTIONS.map(tt => ({
        label: TARGET_TYPE_LABELS[tt],
        onClick: () => setEditTargetType(tt),
    }));

    // --- View mode ---
    if (!isEditing) {
        return (
            <div
                ref={cardRef}
                className="custom-prompt-card"
                onClick={handleEnterEdit}
            >
                <div className="display-flex flex-row items-start justify-between gap-2">
                    <div className="display-flex flex-col flex-1 min-w-0" style={{ gap: '3px' }}>
                        <div className="display-flex flex-row items-center gap-2">
                            <div className="font-color-primary text-sm font-medium">
                                {action.title || <span className="font-color-tertiary">Untitled action</span>}
                            </div>
                            <span className="action-target-badge">{TARGET_TYPE_LABELS[action.targetType]}</span>
                        </div>
                        {action.text && (
                            <div className="font-color-secondary text-sm custom-prompt-card-preview">
                                {action.text}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // --- Edit mode ---
    return (
        <div ref={cardRef} className="custom-prompt-card custom-prompt-card-editing">
            {/* Title input + remove/hide button */}
            <div className="display-flex flex-row items-center gap-2 mb-1">
                <input
                    ref={titleInputRef}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Action title..."
                    maxLength={MAX_TITLE_LENGTH}
                    className="chat-input text-sm font-medium font-color-primary custom-prompt-edit-title"
                />
                {isBuiltin ? (
                    onHide && (
                        <Button
                            variant="ghost-secondary"
                            style={{ padding: "2px 8px", flexShrink: 0 }}
                            onClick={(e) => { e.stopPropagation(); onHide(); setIsEditing(false); }}
                        >
                            <span className="text-xs">Hide</span>
                        </Button>
                    )
                ) : (
                    <IconButton
                        variant="ghost-secondary"
                        icon={CancelIcon}
                        onClick={() => { onRemove(); setIsEditing(false); }}
                        className="scale-90 flex-shrink-0"
                        ariaLabel="Remove action"
                    />
                )}
            </div>

            {/* Content textarea */}
            <textarea
                ref={textareaRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onInput={(e) => {
                    e.currentTarget.style.height = "auto";
                    e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                }}
                placeholder="Enter prompt text..."
                maxLength={MAX_PROMPT_TEXT_LENGTH}
                className="chat-input custom-prompt-edit-textarea text-sm"
                rows={2}
            />

            {/* Options and action buttons */}
            <div className="display-flex flex-row items-center justify-between mt-2">
                <div className="display-flex flex-row items-center gap-3">
                    <label className="text-sm font-color-secondary">Type</label>
                    <MenuButton
                        menuItems={targetTypeMenuItems}
                        buttonLabel={TARGET_TYPE_LABELS[editTargetType]}
                        variant="surface"
                        style={{ padding: '1px 8px', minWidth: '70px' }}
                    />
                    {isBuiltin && isOverridden && onResetToDefault && (
                        <Button
                            variant="ghost-secondary"
                            style={{ padding: "2px 8px" }}
                            onClick={(e) => { e.stopPropagation(); onResetToDefault(); setIsEditing(false); }}
                        >
                            <span className="text-xs font-color-tertiary">Reset to Default</span>
                        </Button>
                    )}
                </div>

                <div className="display-flex flex-row items-center gap-3">
                    <Button
                        type="button"
                        variant="ghost-secondary"
                        style={{ padding: "2px 8px" }}
                        onClick={handleCancel}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="solid"
                        style={{ padding: "2px 8px" }}
                        onClick={handleSave}
                    >
                        Save
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default ActionCard;
