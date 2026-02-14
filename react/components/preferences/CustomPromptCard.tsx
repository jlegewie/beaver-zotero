import React, { useState, useEffect, useRef, useCallback } from "react";
import { CustomPrompt } from "../../types/settings";
import { CancelIcon } from "../icons/icons";
import IconButton from "../ui/IconButton";
import Button from "../ui/Button";

interface CustomPromptCardProps {
    index: number;
    prompt: CustomPrompt;
    onChange: (index: number, updatedPrompt: CustomPrompt) => void;
    onRemove: (index: number) => void;
    availabilityNote?: string;
}

/**
 * Displays a custom prompt as a clean card with view and edit modes.
 * View mode: title in primary, content preview in secondary, hover highlight.
 * Edit mode: inline editing with title input, textarea, options, save/cancel.
 */
const CustomPromptCard: React.FC<CustomPromptCardProps> = ({
    index,
    prompt,
    onChange,
    onRemove,
    availabilityNote
}) => {
    const [isEditing, setIsEditing] = useState(() => !prompt.title && !prompt.text);
    const [editTitle, setEditTitle] = useState(prompt.title);
    const [editText, setEditText] = useState(prompt.text);
    const [editRequiresAttachment, setEditRequiresAttachment] = useState(prompt.requiresAttachment);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const titleInputRef = useRef<HTMLInputElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const previousPromptRef = useRef(prompt);
    // Ref to hold latest draft values so the click-outside listener doesn't re-register on every keystroke
    const draftRef = useRef({ editTitle, editText, editRequiresAttachment });
    useEffect(() => {
        draftRef.current = { editTitle, editText, editRequiresAttachment };
    }, [editTitle, editText, editRequiresAttachment]);

    // Sync local draft state when prompt changes, and always reset if this card now points to a different prompt.
    useEffect(() => {
        const promptSwitched = previousPromptRef.current !== prompt;
        if (promptSwitched || !isEditing) {
            setEditTitle(prompt.title);
            setEditText(prompt.text);
            setEditRequiresAttachment(prompt.requiresAttachment);
        }
        previousPromptRef.current = prompt;
    }, [prompt, prompt.title, prompt.text, prompt.requiresAttachment, isEditing]);

    // Close edit mode on click outside — auto-saves, or removes if the prompt is empty
    useEffect(() => {
        if (!isEditing) return;
        const doc = cardRef.current?.ownerDocument;
        if (!doc) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
                const { editTitle: title, editText: text, editRequiresAttachment: reqAttach } = draftRef.current;
                // New prompt that's still empty — remove it (same as Cancel)
                if (!title && !text && !prompt.title && !prompt.text) {
                    onRemove(index);
                } else {
                    // Auto-save current draft
                    onChange(index, { ...prompt, title, text, requiresAttachment: reqAttach });
                }
                setIsEditing(false);
            }
        };

        doc.addEventListener("mousedown", handleClickOutside);
        return () => doc.removeEventListener("mousedown", handleClickOutside);
    }, [isEditing, prompt, index, onChange, onRemove]);

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
            setEditTitle(prompt.title);
            setEditText(prompt.text);
            setEditRequiresAttachment(prompt.requiresAttachment);
            setIsEditing(true);
        }
    }, [isEditing, prompt]);

    const handleCancel = useCallback(() => {
        // If newly added and still empty, remove it
        if (!prompt.title && !prompt.text) {
            onRemove(index);
        }
        setEditTitle(prompt.title);
        setEditText(prompt.text);
        setEditRequiresAttachment(prompt.requiresAttachment);
        setIsEditing(false);
    }, [prompt, index, onRemove]);

    const handleSave = useCallback(() => {
        const updated: CustomPrompt = {
            ...prompt,
            title: editTitle,
            text: editText,
            requiresAttachment: editRequiresAttachment,
        };
        onChange(index, updated);
        setIsEditing(false);
    }, [prompt, editTitle, editText, editRequiresAttachment, index, onChange]);

    const handleRemove = useCallback(() => {
        onRemove(index);
        setIsEditing(false);
    }, [index, onRemove]);

    const shortcutLabel = Zotero.isMac ? `⌘^${index + 1}` : `Ctrl+Win+${index + 1}`;

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
                        <div className="font-color-primary text-sm font-medium">
                            {prompt.title || <span className="font-color-tertiary">Untitled prompt</span>}
                            <span className="font-color-tertiary text-xs ml-2">{shortcutLabel}</span>
                        </div>
                        {prompt.text && (
                            <div className="font-color-secondary text-sm custom-prompt-card-preview">
                                {prompt.text}
                            </div>
                        )}
                        {availabilityNote && (
                            <div className="text-xs font-color-tertiary" style={{ marginTop: '2px' }}>
                                {availabilityNote}
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
            {/* Title input */}
            <div className="display-flex flex-row items-center gap-2 mb-1">
                <input
                    ref={titleInputRef}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Prompt title..."
                    className="chat-input text-sm font-medium font-color-primary custom-prompt-edit-title"
                />
                <span className="font-color-tertiary text-xs flex-shrink-0">{shortcutLabel}</span>
                <IconButton
                    variant="ghost-secondary"
                    icon={CancelIcon}
                    onClick={handleRemove}
                    className="scale-90 flex-shrink-0"
                    ariaLabel={`Remove prompt ${index + 1}`}
                />
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
                className="chat-input custom-prompt-edit-textarea text-sm"
                rows={2}
            />

            {/* Options and action buttons */}
            <div className="display-flex flex-row items-center justify-between mt-2">
                <label className={`display-flex items-center gap-05 text-sm ${editRequiresAttachment ? 'font-color-primary' : 'font-color-secondary'} cursor-pointer`}>
                    <input
                        type="checkbox"
                        checked={editRequiresAttachment}
                        onChange={(e) => setEditRequiresAttachment(e.target.checked)}
                        className="scale-90"
                    />
                    Requires Attachment
                </label>

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

export default CustomPromptCard;
