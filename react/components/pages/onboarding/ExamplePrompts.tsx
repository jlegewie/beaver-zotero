import React from 'react';

interface ExampleBubbleProps {
    children: React.ReactNode;
    side?: 'left' | 'right';
}

const Highlight: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <span style={{ 
        // color: 'var(--tag-orange)', 
        fontWeight: 600,
        // backgroundColor: 'var(--tag-orange-quarternary)',
        padding: '1px 2px',
        borderRadius: '4px'
    }}>
        {children}
    </span>
);

const ExampleBubble: React.FC<ExampleBubbleProps> = ({ children, side = 'left' }) => {
    const isRight = side === 'right';
    
    // Chat bubble style with one corner less rounded (like a speech bubble tail)
    const bubbleStyle: React.CSSProperties = {
        maxWidth: '85%',
        borderRadius: isRight 
            ? '12px 12px 4px 12px'  // top-left, top-right, bottom-right (small), bottom-left
            : '12px 12px 12px 4px', // top-left, top-right, bottom-right, bottom-left (small)
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
    };
    
    return (
        <div 
            className={`display-flex ${isRight ? 'justify-end' : 'justify-start'}`}
        >
            <div 
                className="user-message-display px-3 py-2"
                style={bubbleStyle}
            >
                <span className="text-base">{children}</span>
            </div>
        </div>
    );
};

/**
 * Example prompts component for onboarding page
 * Shows engaging research-focused example queries with highlighted keywords
 * Uses chat bubble design with alternating left/right alignment
 */
const ExamplePrompts: React.FC = () => {
    return (
        <div 
            className="display-flex flex-col gap-4 select-none pointer-events-none"
            style={{ opacity: 0.6 }}
        >
            <ExampleBubble side="left">
                Summarize the <Highlight>experimental protocols</Highlight> across my papers on <Highlight>neural plasticity</Highlight>
            </ExampleBubble>
            
            <ExampleBubble side="right">
                Compare and contrast all definitions of <Highlight>social capital</Highlight> in my library
            </ExampleBubble>
            
            <ExampleBubble side="left">
                <Highlight>Create a note</Highlight> that compares this article's key findings to related studies
            </ExampleBubble>

            <ExampleBubble side="right">
                Please <Highlight>review my paragraph</Highlight> on the negative effects of microplastic toxicity. Research every citation to ensure accuracy.
            </ExampleBubble>
            
            <ExampleBubble side="left">
                Did the <Highlight>American Economic Review</Highlight> publish recent papers on <Highlight>AI and the labor market</Highlight>?
            </ExampleBubble>
        </div>
    );
};

export default ExamplePrompts;
