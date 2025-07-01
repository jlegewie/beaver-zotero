import React, { useState, useEffect } from "react";
import { CancelIcon } from '../icons/icons';
import IconButton from "../ui/IconButton";
import { CustomPrompt } from "../../types/settings";

interface CustomPromptSettingsProps {
    index: number;
    prompt: CustomPrompt;
    onChange: (index: number, updatedPrompt: CustomPrompt) => void;
    onRemove: (index: number) => void;
}

const CustomPromptSettings: React.FC<CustomPromptSettingsProps> = ({ index, prompt, onChange, onRemove }) => {
    const [text, setText] = useState(prompt.text);
    const [title, setTitle] = useState(prompt.title);

    useEffect(() => {
        setText(prompt.text);
        setTitle(prompt.title);
    }, [prompt.text, prompt.title]);

    const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        setText(newValue);

        if (newValue !== prompt.text) {
            const updated = { ...prompt, text: newValue };
            onChange(index, updated);
        }
    };

    const handleTitleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = event.target.value;
        setTitle(newValue);

        if (newValue !== prompt.title) {
            const updated = { ...prompt, title: newValue };
            onChange(index, updated);
        }
    };

    const handleCheckboxChange = (field: keyof CustomPrompt) => (event: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = event.target.checked;
        const updated = { ...prompt, [field]: newValue };
        onChange(index, updated);
    };

    const handleRemove = () => {
        onRemove(index);
    };

    return (
        <div className="display-flex flex-col gap-2">
            <div className="display-flex flex-row gap-3 items-center justify-between">
                <div className="display-flex flex-row gap-3 items-center">
                    <label className="font-semibold text-sm font-color-primary">
                        Custom Prompt
                    </label>
                    <label className="font-semibold text-sm font-color-secondary">⌘{index + 1}</label>
                </div>
                <IconButton
                    variant="ghost-secondary"
                    icon={CancelIcon}
                    onClick={handleRemove}
                    className="scale-90"
                    ariaLabel={`Remove prompt ${index + 1}`}
                />
            </div>
            <div className="display-flex flex-row gap-2 items-center">
                <label className="text-sm font-color-secondary">Title</label>
                <input
                    type="text"
                    value={title}
                    onChange={handleTitleChange}
                    placeholder={`Enter title for ⌘${index + 1}...`}
                    className="flex-1 p-1 m-0 border text-sm rounded-sm border-quinary bg-senary focus:border-tertiary outline-none"
                />
            </div>
            <textarea
                value={text}
                onChange={handleTextChange}
                placeholder={`Enter prompt text for ⌘${index + 1}...`}
                rows={2}
                className="flex-1 p-1 border rounded-sm border-quinary bg-senary focus:border-tertiary outline-none resize-y text-sm"
            />
            <div className="display-flex flex-row gap-4 items-center">
                <label className={`display-flex items-center gap-05 text-sm ${prompt.librarySearch ? 'font-primary' : 'font-color-secondary'} cursor-pointer`}>
                    <input
                        type="checkbox"
                        checked={prompt.librarySearch}
                        onChange={handleCheckboxChange('librarySearch')}
                        className="scale-90"
                    />
                    Library Search
                </label>
                <label className={`display-flex items-center gap-05 text-sm ${prompt.requiresAttachment ? 'font-primary' : 'font-color-secondary'} cursor-pointer`}>
                    <input
                        type="checkbox"
                        checked={prompt.requiresAttachment}
                        onChange={handleCheckboxChange('requiresAttachment')}
                        className="scale-90"
                    />
                    Requires Attachment
                </label>
            </div>
        </div>
    );
};

export default CustomPromptSettings;