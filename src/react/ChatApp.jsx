import React, { useState } from 'react';

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
    sourcesContainer: {
        marginBottom: '18px',
        minHeight: '24px',
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
    button: {
        border: '1px solid #666',
        backgroundColor: '#444',
        padding: '3px 4px',
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 400,
        color: '#c3c3c3',
        transition: 'background-color 0.2s ease, color 0.2s ease, opacity 0.2s ease',
    },
    escButton: {
        opacity: 0.4,
        '&:hover': {
            opacity: 0.7,
        }
    },
    deepSearchButton: {
        marginRight: '4px',
        opacity: 0.4,
        '&:hover': {
            opacity: 0.7,
        }
    },
    sendButton: {
        color: '#d3d3d3',
    }
};

const ChatApp = () => {
    const [message, setMessage] = useState('');
    const [sendCount, setSendCount] = useState(0);
    
    const handleSubmit = (e) => {
        e.preventDefault();
        console.log('Message sent:', message);
        setMessage('');
        setSendCount(prev => prev + 1);
    };
    
    const handleDeepSearch = () => {
        console.log('Deep search triggered');
    };
    
    const handleEscape = () => {
        setMessage('');
    };
    
    return (
        <div style={styles.chatApp}>
            <div style={styles.container}>
                <form onSubmit={handleSubmit} style={styles.form}>
                    <div style={styles.inputContainer}>
                        <input
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="How can I help you today?"
                            style={styles.input}
                        />
                    </div>
                    <div>
                        Messages sent: {sendCount}
                    </div>
                    
                    <div style={styles.sourcesContainer}>
                        {/* Items will be rendered here */}
                    </div>
                    
                    <div style={styles.buttonsContainer}>
                        <div style={styles.buttonsLeft}>
                            <button
                                type="button"
                                onClick={handleEscape}
                                style={{...styles.button, ...styles.escButton}}
                            >
                                esc
                            </button>
                        </div>
                        
                        <div style={styles.buttonsRight}>
                            <button
                                type="button"
                                onClick={handleDeepSearch}
                                style={{...styles.button, ...styles.deepSearchButton}}
                            >
                                Deep Search ⌘ ⏎
                            </button>
                            
                            <button
                                type="submit"
                                style={{...styles.button, ...styles.sendButton}}
                            >
                                Send ⏎
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ChatApp;