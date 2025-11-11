import React from 'react';

/**
 * Parse text to support newlines and HTML anchor tags
 * @param text Text that may contain newlines and <a> tags
 * @returns React elements with proper formatting and clickable links
 */
export const parseTextWithLinksAndNewlines = (text: string): React.ReactNode => {
    const htmlLinkRegex = /<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    
    return text.split('\n').map((line, lineIndex, lines) => {
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null = null;
        
        // Reset regex
        htmlLinkRegex.lastIndex = 0;
        
        while ((match = htmlLinkRegex.exec(line)) !== null) {
            // Add text before the link
            if (match.index > lastIndex) {
                parts.push(
                    <span key={`text-${lastIndex}`}>
                        {line.substring(lastIndex, match.index)}
                    </span>
                );
            }
            
            // Capture match values to avoid closure issue
            const url = match[1];
            const linkText = match[2];
            const matchIndex = match.index;
            const matchLength = match[0].length;
            
            // Add the clickable link
            parts.push(
                <a
                    key={`link-${matchIndex}`}
                    href="#"
                    className="text-link"
                    onClick={(e) => {
                        e.preventDefault();
                        Zotero.launchURL(url);
                    }}
                >
                    {linkText}
                </a>
            );
            
            lastIndex = matchIndex + matchLength;
        }
        
        // Add remaining text after all links
        if (lastIndex < line.length) {
            parts.push(
                <span key={`text-${lastIndex}`}>
                    {line.substring(lastIndex)}
                </span>
            );
        }
        
        return (
            <React.Fragment key={lineIndex}>
                {parts.length > 0 ? parts : line}
                {lineIndex < lines.length - 1 && <br />}
            </React.Fragment>
        );
    });
};