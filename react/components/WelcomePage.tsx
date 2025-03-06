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
            title: "Summarize",
            prompt: "Provide a detailed summary of the article.",
            shortcut: "⌘1"
        },
        {
            title: "Short Summary",
            prompt: "Provide a short summary of the article.",
            shortcut: "⌘2"
        }   
    ]

    return (
        <div 
            id="beaver-welcome"
            className="flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 p-4"
        >
            {/* <div className="flex-1"/> */}
            <div style={{height: "10%"}}/>
            <h1 className="font-bold text-lg">Quick Prompts</h1>
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