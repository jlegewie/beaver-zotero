// @ts-ignore no idea
import React from "react";
import Button from "./Button";

type Prompt = {
    title: string;
    prompt: string;
    shortcut: string;
}

const WelcomePage: React.FC = () => {

    const prompts: Prompt[] = [
        {
            title: "Structured Summary",
            prompt: "Provide a detailed and structured summary of the article.",
            shortcut: "⌘1"
        },
        {
            title: "Short Summary",
            prompt: "Provide a short summary of the article.",
            shortcut: "⌘2"
        },   
        {
            title: "Key Findings",
            prompt: "Extract the key findings of the article.",
            shortcut: "⌘3"
        },
        {
            title: "Literature Review",
            prompt: "Provide a broad literature review based on the research discussed in the article.",
            shortcut: "⌘4"
        },
        {
            title: "Critical assessment",
            prompt: "Provide a critical assessment of the article. Structure your assessment based on the article's structure such as introduction, methods, results, discussion, and conclusion.",
            shortcut: "⌘5"
        },
        {
            title: "Propose testable hypotheses",
            prompt: "Generate testable hypotheses for future research that build on and follow up on the article. The hypotheses should be specific and testable. Describe each hypothesis in a separate paragraph.",
            shortcut: "⌘6"
        }
    ]

    return (
        <div 
            id="beaver-welcome"
            className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 p-4"
        >
            {/* <div className="flex-1"/> */}
            <div style={{height: "10%"}}/>
            <div className="flex flex-row justify-between items-center">
                <div className="font-semibold text-lg mb-1">Quick Prompts</div>
                <Button variant="outline" className="scale-85 fit-content"> Edit </Button>
            </div>
            {prompts.map((prompt, index) => (
                <Button
                    key={index}
                    variant="surface"
                    className="welcome-page-button"
                >
                    <span className="font-color-tertiary text-base">
                        {prompt.shortcut}
                    </span>
                    <span className="font-color-secondary text-base">
                        {prompt.title}
                    </span>
                </Button>
            ))}
            
        </div>
    );
};

export default WelcomePage;