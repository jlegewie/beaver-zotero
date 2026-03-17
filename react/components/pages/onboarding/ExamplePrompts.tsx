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

const ExampleBubble: React.FC<ExampleBubbleProps & { delay?: number }> = ({ children, side = 'left', delay = 0 }) => {
    const isRight = side === 'right';
    
    // Chat bubble style with one corner less rounded (like a speech bubble tail)
    const bubbleStyle: React.CSSProperties = {
        maxWidth: '85%',
        borderRadius: isRight 
            ? '12px 12px 4px 12px'  // top-left, top-right, bottom-right (small), bottom-left
            : '12px 12px 12px 4px', // top-left, top-right, bottom-right, bottom-left (small)
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
        animation: `fadeInUp 0.6s ease-out ${delay}s forwards`,
        opacity: 0,
    };
    
    return (
        <div 
            className={`display-flex ${isRight ? 'justify-end' : 'justify-start'}`}
        >
            <div 
                className="user-message-display px-3 py-2"
                style={bubbleStyle}
            >
                <span className="text-base font-color-primary">{children}</span>
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
        <>
            <style>{`
                @keyframes fadeInUp {
                    from {
                        opacity: 0;
                        transform: translateY(10px);
                    }
                    to {
                        opacity: 0.85;
                        transform: translateY(0);
                    }
                }
            `}</style>
            <div 
                className="display-flex flex-col gap-4 select-none pointer-events-none"
            >
                <ExampleBubble side="left" delay={0.2}>
                    Summarize methods <Highlight>across my library</Highlight> on neural plasticity
                </ExampleBubble>
                
                <ExampleBubble side="left" delay={0.8}>
                    <Highlight>Organize new items</Highlight> into my collections
                </ExampleBubble>
                
                <ExampleBubble side="left" delay={1.4}>
                    Create a note that <Highlight>compares this article to related studies</Highlight>
                </ExampleBubble>

                <ExampleBubble side="left" delay={2.0}>
                    <Highlight>Review citation accuracy</Highlight> in this paragraph
                </ExampleBubble>
                
                <ExampleBubble side="left" delay={2.4}>
                    <Highlight>Find recent papers</Highlight> on AI and the labor market
                </ExampleBubble>
            </div>
        </>
    );
};

export default ExamplePrompts;
