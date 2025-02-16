import React, { useState, useRef, useEffect } from 'react';
import { Button } from "./components/button.tsx"
import { ContextItem } from "./components/contextItem.tsx"
import { getInTextCitations, getBibliographies } from "../src/utils/citations.ts"

const styles = {
    chatApp: {
        fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif',
        padding: '12px',
    },
    container: {
        margin: '0 auto',
        padding: '1rem',
        // backgroundColor: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: '6px',
        // borderRadius: '0.5rem'
    },
    form: {
        display: 'flex',
        flexDirection: 'column',
    },
    inputContainer: {
        marginBottom: '6px',
        marginLeft: '-3px',
    },
    input: {
        width: 'calc(100% - 23px)',
        fontSize: '13px',
        padding: '6px 8px',
        border: '1px solid #333',
        backgroundColor: '#222',
        borderRadius: '6px',
        marginRight: '-2px',
        outline: 'none',
        color: '#888',
    },
    contextItemsContainer: {
        marginBottom: '18px',
        minHeight: '24px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
    },
    buttonsContainer: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: '10px',
    },
    buttonsLeft: {
        display: 'flex',
        flex: 1,
    },
    buttonsRight: {
        display: 'flex',
        gap: '6px',
    },
    button: undefined,
    escButton: {
        opacity: 0.4,
    },
    deepSearchButton: {
        marginRight: '4px',
        opacity: 0.4,
    },
    sendButton: {
        color: '#d3d3d3',
    }
};

const ChatApp = () => {
    const [message, setMessage] = useState('');
    const [sendCount, setSendCount] = useState(0);
    const [isCommandPressed, setIsCommandPressed] = useState(false);
    const [contextItems, setContextItems] = useState([]);
    const inputRef = useRef(null);
    
    // Subscribe to events from Zotero
    useEffect(() => {
        // Get the event bus from the window
        const eventBus = window.__beaverEventBus;
        if (!eventBus) return;

        const handleFocus = () => {
            // Add selected items to context
            const items = Zotero.getActiveZoteroPane().getSelectedItems();
            setContextItems(items);
            // Focus on text field
            inputRef.current?.focus();
        };

        // "itemSelected" event to update our log
        const handleItemSelected = (e) => {
            const { detail } = e;
        };

        eventBus.addEventListener('focusChatInput', handleFocus);
        eventBus.addEventListener('itemSelected', handleItemSelected);

        // Clean up the event listeners when the component unmounts.
        return () => {
            eventBus.removeEventListener('focusChatInput', handleFocus);
            eventBus.removeEventListener('itemSelected', handleItemSelected);
        };
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (isCommandPressed) {
            handleDeepSearch();
        } else {
            console.log('Message sent:', message);
            setMessage('');
            setSendCount(prev => prev + 1);
        }
    };
    
    const handleDeepSearch = () => {
        console.log('Deep search triggered');
        const items = Zotero.getActiveZoteroPane().getSelectedItems();
        setContextItems(items);
    };
    
    const handleEscape = () => {
        setMessage('');
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(true);
        }
    };

    const handleKeyUp = (e) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(false);
        }
    };
    
    return (
        <div style={styles.chatApp}>
            <div style={styles.container}>
                <form onSubmit={handleSubmit} style={styles.form}>
                    <div style={styles.inputContainer}>
                        <input
                            ref={inputRef}
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="How can I help you today?"
                            style={styles.input}
                            onKeyDown={handleKeyDown}
                            onKeyUp={handleKeyUp}
                        />
                    </div>
                    <div style={styles.contextItemsContainer}>
                        {contextItems.map((item, index) => (
                            <ContextItem
                                key={index}
                                icon={item.getItemTypeIconName()}
                                tooltip={getBibliographies([item])[0]}
                                variant="dark"
                                onRemove={() => alert('test')}
                            >
                                {getInTextCitations([item])[0]}
                            </ContextItem>
                        ))}
                    </div>
                    <div style={styles.buttonsContainer}>
                        <div style={styles.buttonsLeft}>
                            <Button
                                type="button"
                                onClick={handleEscape}
                                variant="ghost"
                            >
                                esc
                            </Button>
                        </div>
                        
                        <div style={styles.buttonsRight}>
                            <Button
                                type="button"
                                onClick={handleDeepSearch}
                                variant={isCommandPressed ? "dark" : "ghost"}
                                style={{ marginRight: '4px' }}
                            >
                                Library Search ⌘ ⏎
                            </Button>
                            
                            <Button
                                type="submit"
                                variant={isCommandPressed ? "ghost" : "dark"}
                            >
                                Send ⏎
                            </Button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ChatApp;