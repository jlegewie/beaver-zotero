import React, { useState, useEffect, useRef, useCallback } from "react";
import { Action, ActionTargetType, TARGET_TYPE_LABELS } from "../../types/actions";
import Button from "../ui/Button";
import MenuButton from "../ui/MenuButton";
import { MenuItem } from "../ui/menu/ContextMenu";
import { ArrowDownIcon } from "../icons/icons";

const MAX_TITLE_LENGTH = 45;
const MAX_PROMPT_TEXT_LENGTH = 2250;

const TARGET_TYPE_OPTIONS: ActionTargetType[] = ["items", "attachment", "note", "collection", "global"];

interface ActionCardProps {
    action: Action;
    onChange: (updatedAction: Action) => void;
    onRemove: () => void;
    onHide?: () => void;
    onResetToDefault?: () => void;
    isBuiltin: boolean;
    isOverridden: boolean;
    hasBorder?: boolean;
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
                className={`action-card ${hasBorder ? 'border-top-quinary' : ''}`}
                onClick={handleEnterEdit}
            >
                <div className="display-flex flex-col flex-1 min-w-0" style={{ gap: '3px' }}>
                    <div className="display-flex flex-row items-center gap-2">
                        <div className="font-color-primary text-sm font-medium">
                            {action.title || <span className="font-color-tertiary">Untitled action</span>}
                        </div>
                        <span className="action-target-badge" data-type={action.targetType}>
                            {TARGET_TYPE_LABELS[action.targetType]}
                        </span>
                    </div>
                    {action.text && (
                        <div className="font-color-secondary text-sm action-card-preview">
                            {action.text}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // --- Edit mode ---
    return (
        <div ref={cardRef} className={`action-card action-card-editing ${hasBorder ? 'border-top-quinary' : ''}`}>
            <input
                ref={titleInputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Action title..."
                maxLength={MAX_TITLE_LENGTH}
                className="chat-input text-sm font-medium font-color-primary action-edit-title"
            />

            <textarea
                ref={textareaRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onInput={(e) => {
                    e.currentTarget.style.height = "auto";
                    e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                }}
                placeholder="Enter prompt text... Use {{active_item}}, {{selected_items}}, or {{recent_items}} to insert context."
                maxLength={MAX_PROMPT_TEXT_LENGTH}
                className="chat-input custom-prompt-edit-textarea text-sm"
                rows={2}
            />

            <div className="display-flex flex-row items-center justify-between mt-2">
                <div className="display-flex flex-row items-center gap-3">
                    <MenuButton
                        menuItems={targetTypeMenuItems}
                        buttonLabel={TARGET_TYPE_LABELS[editTargetType]}
                        variant="surface"
                        rightIcon={ArrowDownIcon}
                        className="action-target-badge"
                        dataType={editTargetType}
                        customContent={<span>{TARGET_TYPE_LABELS[editTargetType]}</span>}
                        style={{ padding: '2px 6px', fontSize: '12px' }}
                    />
                    {isBuiltin && isOverridden && onResetToDefault && (
                        <Button
                            variant="ghost-secondary"
                            style={{ padding: "2px 8px" }}
                            onClick={(e) => { e.stopPropagation(); onResetToDefault(); setIsEditing(false); }}
                        >
                            <span className="text-xs">Reset to Default</span>
                        </Button>
                    )}
                </div>

                <div className="display-flex flex-row items-center gap-3">
                    {isBuiltin ? (
                        onHide && (
                            <Button
                                variant="ghost-secondary"
                                style={{ padding: "2px 8px" }}
                                onClick={(e) => { e.stopPropagation(); onHide(); setIsEditing(false); }}
                            >
                                <span className="text-xs">Hide</span>
                            </Button>
                        )
                    ) : (
                        <Button
                            variant="ghost-secondary"
                            style={{ padding: "2px 8px" }}
                            onClick={() => { onRemove(); setIsEditing(false); }}
                        >
                            <span className="text-xs">Delete</span>
                        </Button>
                    )}
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
