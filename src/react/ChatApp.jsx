import React, { useState } from 'react';

const styles = {
    container: {
        width: '80%',
        maxWidth: '64rem',
        margin: '0 auto',
        padding: '1rem',
        backgroundColor: '#1a1a1a',
        borderRadius: '0.5rem'
    },
    form: {
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem'
    },
    inputWrapper: {
        position: 'relative',
        width: '100%'
    },
    input: {
        width: '100%',
        padding: '1rem',
        backgroundColor: '#2a2a2a',
        color: '#e0e0e0',
        borderRadius: '0.5rem',
        border: 'none',
        outline: 'none',
        fontSize: '1rem'
    },
    buttonContainer: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '1rem'
    },
    rightButtons: {
        display: 'flex',
        gap: '1rem'
    },
    button: {
        padding: '0.5rem 1rem',
        backgroundColor: '#2a2a2a',
        color: '#9ca3af',
        borderRadius: '0.5rem',
        border: 'none',
        cursor: 'pointer',
        fontSize: '1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        transition: 'background-color 0.2s'
    }
};

const ChatApp = () => {
    const [message, setMessage] = useState('');
    
    const handleSubmit = (e) => {
        e.preventDefault();
        console.log('Message sent:', message);
        setMessage('');
    };
    
    const handleDeepSearch = () => {
        console.log('Deep search triggered');
    };
    
    const handleEscape = () => {
        setMessage('');
    };
    
    return (
        <div>
            <div style={styles.container}>
                <form onSubmit={handleSubmit} style={styles.form}>
            <div style={styles.inputWrapper}>
            <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="How can I help you today?"
                style={styles.input}
            />
            </div>
            
            <div style={styles.buttonContainer}>
            <button
                type="button"
                onClick={handleEscape}
                style={styles.button}
            >
                esc
            </button>
            
            <div style={styles.rightButtons}>
            <button
                type="button"
                onClick={handleDeepSearch}
                style={styles.button}
            >
                Library Search ⌘ ⏎
            </button>
            
            <button
            type="submit"
            style={styles.button}
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