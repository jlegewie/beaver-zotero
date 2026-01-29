import React, { useState, useCallback } from 'react';
import { FeatureStep, ExamplePrompt } from '../../../constants/versionUpdateMessages';
import Button from '../Button';
import { ArrowRightIcon } from '../../icons/icons';
import { parseTextWithLinksAndNewlines } from '../../../utils/parseTextWithLinksAndNewlines';

interface FeatureTourContentProps {
    steps: FeatureStep[];
    onComplete: () => void;
}

/**
 * Renders a single example prompt as a compact chat bubble
 */
const PromptBubble: React.FC<{ prompt: ExamplePrompt }> = ({ prompt }) => {
    const position = prompt.position || 'left';
    
    // Render text with highlighted portion
    const renderText = () => {
        if (!prompt.highlight) {
            return <span>{prompt.text}</span>;
        }
        
        const index = prompt.text.indexOf(prompt.highlight);
        if (index === -1) {
            return <span>{prompt.text}</span>;
        }
        
        const before = prompt.text.slice(0, index);
        const after = prompt.text.slice(index + prompt.highlight.length);
        
        return (
            <>
                {before}
                <span className="prompt-highlight">{prompt.highlight}</span>
                {after}
            </>
        );
    };
    
    const alignmentClass = position === 'right' 
        ? 'items-end' 
        : position === 'center' 
            ? 'items-center' 
            : 'items-start';
    
    return (
        <div className={`display-flex flex-col ${alignmentClass} w-full`}>
            <div 
                className="prompt-bubble-compact"
                style={{
                    maxWidth: position === 'center' ? '95%' : '90%',
                }}
            >
                {renderText()}
            </div>
        </div>
    );
};

/**
 * Step indicator dots showing current progress
 */
const StepIndicator: React.FC<{ 
    totalSteps: number; 
    currentStep: number;
    onStepClick: (step: number) => void;
}> = ({ totalSteps, currentStep, onStepClick }) => {
    return (
        <div className="display-flex flex-row gap-2 justify-center py-2 ml-1">
            {Array.from({ length: totalSteps }, (_, i) => (
                <button
                    key={i}
                    onClick={() => onStepClick(i)}
                    className={`step-indicator-dot ${i === currentStep ? 'active' : ''}`}
                    aria-label={`Go to step ${i + 1}`}
                />
            ))}
        </div>
    );
};

/**
 * Feature tour component with step-by-step navigation
 */
const FeatureTourContent: React.FC<FeatureTourContentProps> = ({ steps, onComplete }) => {
    const [currentStep, setCurrentStep] = useState(0);
    
    const isLastStep = currentStep === steps.length - 1;
    const step = steps[currentStep];
    
    const handleNext = useCallback(() => {
        if (isLastStep) {
            onComplete();
        } else {
            setCurrentStep(prev => prev + 1);
        }
    }, [isLastStep, onComplete]);
    
    const handleStepClick = useCallback((step: number) => {
        setCurrentStep(step);
    }, []);
    
    if (!step) return null;
    
    return (
        <div className="feature-tour-content display-flex flex-col gap-3 w-full">
            {/* Step content - scrollable area */}
            <div className="display-flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: '300px' }}>
                {/* Title */}
                <div className="text-lg font-medium font-color-primary">
                    {step.title}
                </div>
                
                {/* Description */}
                {step.description && (
                    <div className="text-sm font-color-secondary">
                        {parseTextWithLinksAndNewlines(step.description)}
                    </div>
                )}
                
                {/* Example prompts - compact */}
                {step.examplePrompts && step.examplePrompts.length > 0 && (
                    <div className="display-flex flex-col gap-3 mt-2">
                        {step.examplePrompts.map((prompt, index) => (
                            <PromptBubble key={index} prompt={prompt} />
                        ))}
                    </div>
                )}
            </div>
            
            {/* Footer: Learn more + Step indicator + Navigation */}
            <div className="display-flex flex-col gap-3 pt-1">
                {/* Learn more link */}
                {step.learnMoreUrl && (
                    <a
                        href={step.learnMoreUrl}
                        className="text-link text-sm"
                        onClick={(e) => {
                            e.preventDefault();
                            Zotero.launchURL(step.learnMoreUrl!);
                        }}
                    >
                        Learn more →
                    </a>
                )}
                
                {/* Step indicator + Navigation row */}
                <div className="display-flex flex-row justify-between items-center">
                    {/* Step indicator on the left */}
                    <div>
                        {steps.length > 1 && (
                            <StepIndicator 
                                totalSteps={steps.length} 
                                currentStep={currentStep}
                                onStepClick={handleStepClick}
                            />
                        )}
                    </div>
                    
                    {/* Navigation buttons on the right */}
                    <div className="display-flex flex-row gap-2">
                        {!isLastStep && (
                            <Button 
                                variant="ghost-secondary" 
                                onClick={onComplete}
                            >
                                Skip
                            </Button>
                        )}
                        <Button 
                            variant="solid" 
                            onClick={handleNext}
                            rightIcon={!isLastStep ? ArrowRightIcon : undefined}
                        >
                            {isLastStep ? 'Get Started' : 'Next'}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FeatureTourContent;
