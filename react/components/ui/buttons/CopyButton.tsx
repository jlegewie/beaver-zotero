import React, { useState } from 'react';
import { CopyIcon, TickIcon } from '../../icons/icons';
import IconButton from '../IconButton';
import { copyToClipboard } from '../../../utils/clipboard';

interface CopyButtonProps {
    /** Text content to copy */
    content: string;
    /** Optional class name for styling */
    className?: string;
    /** Optional callback when copy is successful */
    onCopySuccess?: () => void;
    /** Convert content to a different format before copying */
    formatContent?: (content: string) => string;
    /** Optional title for the button */
    title?: string;
    /** Accessible label for the button */
    ariaLabel?: string;
    /** Button variant */
    variant?: 'solid' | 'surface' | 'outline' | 'subtle' | 'ghost';
}

/**
 * A button that copies text to clipboard and shows a success animation
 * This component handles its own state to minimize parent re-renders
 */
const CopyButton: React.FC<CopyButtonProps> = ({
    content,
    className = 'scale-12',
    onCopySuccess,
    formatContent = (text) => text,
    title = 'Copy to clipboard',
    ariaLabel = 'Copy to clipboard',
    variant = 'ghost'
}) => {
    const [justCopied, setJustCopied] = useState(false);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        
        const formattedContent = formatContent(content);
        
        await copyToClipboard(formattedContent, {
            onSuccess: () => {
                setJustCopied(true);
                setTimeout(() => setJustCopied(false), 600);
                
                if (onCopySuccess) {
                    onCopySuccess();
                }
            }
        });
    };

    return (
        <IconButton
            icon={justCopied ? TickIcon : CopyIcon}
            onClick={handleCopy}
            className={className}
            ariaLabel={ariaLabel}
            title={title}
            variant={variant}
        />
    );
};

export default CopyButton; 