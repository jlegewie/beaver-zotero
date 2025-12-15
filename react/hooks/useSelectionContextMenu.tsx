import React, { useState, useEffect } from 'react';
import { MenuPosition } from '../components/ui/menu/ContextMenu';
import { getWindowFromElement, getDocumentFromElement } from '../utils/windowContext';

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
        // Get the correct document context from the element ref
        const win = getWindowFromElement(elementRef.current);
        const doc = getDocumentFromElement(elementRef.current);
        
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