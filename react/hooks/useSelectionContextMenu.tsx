import React, { useState, useEffect } from 'react';
import { MenuPosition } from '@beaver/agent-ui/primitives/ContextMenu';
import { getWindowFromElement, getDocumentFromElement } from '@beaver/agent-ui/utils/windowContext';

interface UseSelectionContextMenuOptions {
    onCopy?: (selectedText: string) => void;
    customMenuItems?: Array<{
        label: string;
        onClick: (selectedText: string) => void;
        disabled?: boolean;
    }>;
}

interface UseSelectionContextMenuResult {
    isMenuOpen: boolean;
    menuPosition: MenuPosition;
    closeMenu: () => void;
    handleContextMenu: (e: React.MouseEvent) => void;
    menuItems: Array<{
        label: string;
        onClick: () => void;
        disabled?: boolean;
    }>;
}

/**
* A hook for handling text selection context menus
*/
export default function useSelectionContextMenu(
    elementRef: React.RefObject<HTMLElement>,
    options: UseSelectionContextMenuOptions = {}
): UseSelectionContextMenuResult {
    const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [selectedText, setSelectedText] = useState<string>('');
    
    // Handler for right-click context menu
    const handleContextMenu = (e: React.MouseEvent) => {
        // Get the correct window context from the element ref
        const win = getWindowFromElement(elementRef.current);
        if (!win) return;

        // Check if there's selected text
        const selection = win.getSelection();
        const text = selection?.toString() || '';
        
        // Only show menu if text is selected
        if (text.trim().length > 0) {
            e.preventDefault();
            setMenuPosition({ x: e.clientX, y: e.clientY });
            setSelectedText(text);
            setIsMenuOpen(true);
        }
    };
    
    // Close the menu when selection changes or is removed
    useEffect(() => {
        // Get the correct document context from the element ref. The element is
        // absent until the consumer has rendered it, and a consumer may render
        // nothing at first (ModelResponseView returns null until a response has
        // content). Skipping the listener on that pass costs nothing: this effect
        // re-runs when `isMenuOpen` changes, and the menu can only open from a
        // right-click on the element, so the run that matters always has it.
        const win = getWindowFromElement(elementRef.current);
        const doc = getDocumentFromElement(elementRef.current);
        if (!win || !doc) return;

        const handleSelectionChange = () => {
            const selection = win.getSelection();
            const text = selection?.toString() || '';
            
            if (text.trim().length === 0 && isMenuOpen) {
                setIsMenuOpen(false);
            }
        };
        
        doc.addEventListener('selectionchange', handleSelectionChange);
        return () => {
            doc.removeEventListener('selectionchange', handleSelectionChange);
        };
    }, [isMenuOpen, elementRef]);
    
    // Handle keyboard copy (Cmd+C on Mac, Ctrl+C on Windows/Linux)
    useEffect(() => {
        const element = elementRef.current;
        if (!element) return;
        
        const win = getWindowFromElement(element);
        const doc = getDocumentFromElement(element);
        if (!win || !doc) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Check for Cmd+C (Mac) or Ctrl+C (Windows/Linux)
            const isCopyShortcut = (e.metaKey || e.ctrlKey) && e.key === 'c';
            if (!isCopyShortcut) return;
            
            // Check if there's selected text within our element
            const selection = win.getSelection();
            const text = selection?.toString() || '';
            
            if (text.trim().length > 0) {
                // Check if selection is within our element
                const anchorNode = selection?.anchorNode;
                if (anchorNode && element.contains(anchorNode)) {
                    // Copy to clipboard
                    navigator.clipboard.writeText(text);
                    if (options.onCopy) {
                        options.onCopy(text);
                    }
                }
            }
        };
        
        doc.addEventListener('keydown', handleKeyDown);
        return () => {
            doc.removeEventListener('keydown', handleKeyDown);
        };
    }, [elementRef, options]);
    
    // Default copy handler
    const defaultCopyHandler = () => {
        if (selectedText) {
            navigator.clipboard.writeText(selectedText);
            if (options.onCopy) {
                options.onCopy(selectedText);
            }
        }
    };
    
    // Generate menu items - default Copy action plus any custom items
    const menuItems = [
        {
            label: 'Copy',
            onClick: defaultCopyHandler
        },
        ...(options.customMenuItems?.map(item => ({
            label: item.label,
            onClick: () => item.onClick(selectedText),
            disabled: item.disabled
        })) || [])
    ];
    
    return {
        isMenuOpen,
        menuPosition,
        closeMenu: () => setIsMenuOpen(false),
        handleContextMenu,
        menuItems
    };
} 