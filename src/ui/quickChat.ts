import { BasicOptions } from "zotero-plugin-toolkit/dist/basic";
import { BasicTool, ManagerTool } from "zotero-plugin-toolkit/dist/basic";
import { UITool } from "zotero-plugin-toolkit/dist/tools/ui";
import { getFormattedReferences } from "../utils/citations"

/**
* Options for the QuickChat's callbacks.
*/
export interface QuickChatOptions {
    deepSearch?: (question: string) => void;
    send?: (question: string) => void;
}

/**
* A simplified UI element that:
* 1. Shows a text input to ask "How can I help you today?" (placeholder).
* 2. Displays a list of items (citations) with an "x" to remove items.
* 3. Displays instructions (footer) with:
*    - `esc` on the left to close
*    - `Deep Search ⌘ ⏎` & `Send ⏎` on the right
*      - By default, `Send ⏎` is highlighted
*      - If user holds the ⌘ key, `Deep Search ⌘ ⏎` is highlighted
*/
export class QuickChat extends BasicTool {
    private ui: UITool;
    
    private overlay!: HTMLDivElement;       // Overlay (click-away zone)
    private container!: HTMLDivElement;     // Main container
    private inputField!: HTMLInputElement;  // Input for the user's question
    private itemsContainer!: HTMLDivElement; // Where items are rendered
    
    private items: Zotero.Item[] = [];
    
    /** Callback references */
    private deepSearchCallback?: (q: string) => void;
    private sendCallback?: (q: string) => void;
    
    /** Track if the user is holding the Meta (⌘) key */
    private isMetaKeyHeld = false;
    
    /** Placeholder text for the user's question */
    private placeholderText = "How can I help you today?";
    
    constructor(options?: QuickChatOptions, base?: BasicOptions | BasicTool) {
        super(base);
        this.ui = new UITool(base);
        
        this.deepSearchCallback = options?.deepSearch;
        this.sendCallback = options?.send;
        
        this.injectStyles();
        this.createUI();
        this.attachGlobalKeyEvents();
    }
    
    /**
    * Creates the HTML structure for the QuickChat.
    */
    private createUI(): void {
        const doc = this.getGlobal("document");
        
        // A semi-transparent overlay that closes the UI on click
        this.overlay = this.ui.createElement(doc, "div", {
            styles: {
                display: "none",
                position: "fixed",
                left: "0",
                top: "0",
                width: "100%",
                height: "100%",
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                zIndex: "99998",
                cursor: "pointer",
                opacity: "0",  // Start fully transparent
                transition: "opacity 0.2s ease", // Add smooth transition
            },
            listeners: [
                {
                    type: "click",
                    listener: () => {
                        // Clicking outside closes the UI
                        this.hide();
                    },
                },
            ],
        }) as HTMLDivElement;
        
        // Main container (card-like UI)
        this.container = this.ui.createElement(doc, "div", {
            classList: ["quick-chat-container"],
            styles: {
                display: "none",
                position: "fixed",
                left: "50%",
                top: "15%",
                transform: "translateX(-50%)",
                width: "40%",
                minWidth: "400px",
                zIndex: "99999",
                borderRadius: "10px",
                backgroundColor: "var(--material-background, #fff)",
                boxShadow:
                "0 2px 8px rgba(0,0,0,0.15), 0 6px 20px rgba(0,0,0,0.4)",
                fontFamily:
                "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif",
                padding: "16px",
            },
            children: [
                // Input Container
                {
                    tag: "div",
                    classList: ["quick-chat-input-container"],
                    children: [
                        {
                            tag: "input",
                            classList: ["quick-chat-input"],
                            attributes: {
                                type: "text",
                                placeholder: this.placeholderText,
                            },
                        },
                    ],
                },
                // Items container
                {
                    tag: "div",
                    classList: ["quick-chat-sources-container"],
                },
                // Instructions (footer)
                {
                    tag: "div",
                    classList: ["quick-chat-buttons"],
                    children: [
                        // Left side: `esc`
                        {
                            tag: "div",
                            classList: ["quick-chat-buttons-left"],
                            children: [
                                {
                                    tag: "button",
                                    classList: ["quick-chat-esc-btn", "inactive-btn"],
                                    properties: {
                                        innerText: "esc",
                                    },
                                    listeners: [
                                        {
                                            type: "click",
                                            listener: () => this.hide(),
                                        },
                                    ],
                                },
                            ],
                        },
                        // Right side: `Deep Search ⌘ ⏎` & `Send ⏎`
                        {
                            tag: "div",
                            classList: ["quick-chat-buttons-right"],
                            children: [
                                {
                                    tag: "button",
                                    classList: ["deep-search-btn", "quick-chat-btn", "inactive-btn"],
                                    properties: {
                                        innerText: "Deep Search ⌘ ⏎",
                                    },
                                    listeners: [
                                        {
                                            type: "click",
                                            listener: () => this.deepSearch(),
                                        },
                                    ],
                                },
                                {
                                    tag: "button",
                                    classList: ["send-btn", "quick-chat-btn", "highlighted-btn"],
                                    properties: {
                                        innerText: "Send ⏎",
                                    },
                                    listeners: [
                                        {
                                            type: "click",
                                            listener: () => this.send(),
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        }) as HTMLDivElement;
        
        doc.documentElement.appendChild(this.overlay);
        doc.documentElement.appendChild(this.container);
        
        // Save references
        this.inputField = this.container.querySelector(".quick-chat-input") as HTMLInputElement;
        this.itemsContainer = this.container.querySelector(".quick-chat-sources-container") as HTMLDivElement;
        
        // Initial render
        this.renderItems();
    }
    
    /**
    * Renders the items (e.g. `Author 2024 x`) in the itemsContainer.
    */
    private renderItems(): void {
        this.itemsContainer.innerHTML = "";
        const doc = this.getGlobal("document");

        const formatedItems = getFormattedReferences(this.items);
        
        formatedItems.forEach((item, idx) => {
            const itemEl = this.ui.createElement(doc, "span", {
                classList: ["quick-chat-item"],
                attributes: {
                    title: `${item.bibliography}`,
                },
                children: [
                    {
                        tag: "span",
                        properties: {
                            innerText: item.inTextCitation,
                        },
                    },
                    {
                        tag: "span",
                        classList: ["remove-item-btn"],
                        properties: {
                            innerText: " ×",
                        },
                        listeners: [
                            {
                                type: "click",
                                listener: (evt: Event) => {
                                    evt.stopPropagation();
                                    this.removeItem(idx);
                                },
                            },
                        ],
                    },
                ],
            });
            this.itemsContainer.appendChild(itemEl);
        });
    }
    
    /**
    * Removes an item at index and re-renders.
    */
    private removeItem(index: number): void {
        this.items.splice(index, 1);
        this.renderItems();
    }
    
    /**
    * Show the UI (overlay + container).
    */
    public show(): void {
        // Get current context
        this.items = Zotero.getActiveZoteroPane().getSelectedItems();

        // Render
        this.renderItems();

        this.overlay.style.display = "block";
        // Force a reflow to ensure the transition works
        void this.overlay.offsetHeight;
        this.overlay.style.opacity = "1";
        this.container.style.display = "flex";
        
        // auto-focus on the input
        setTimeout(() => {
            this.inputField.focus();
        }, 50);
    }
    
    /**
    * Hide the UI.
    */
    public hide(): void {
        this.overlay.style.opacity = "0";
        // Wait for transition to complete before hiding
        setTimeout(() => {
            this.overlay.style.display = "none";
            this.container.style.display = "none";
        }, 200); // Match transition duration
    }
    
    /**
    * Internal: handle the `Deep Search` action.
    */
    private deepSearch(): void {
        if (this.deepSearchCallback) {
            this.deepSearchCallback(this.inputField.value || "");
        }
        this.hide();
    }
    
    /**
    * Internal: handle the `Send` action.
    */
    private send(): void {
        if (this.sendCallback) {
            this.sendCallback(this.inputField.value || "");
        }
        this.hide();
    }
    
    /**
    * Listen for global key events:
    * - Track if ⌘ is pressed to highlight the `Deep Search` button
    * - Close UI on ESC
    */
    private attachGlobalKeyEvents(): void {
        const doc = this.getGlobal("document");
        
        doc.addEventListener("keydown", (evt) => {
            if (evt.key === "Meta") {
                this.isMetaKeyHeld = true;
                this.updateButtonHighlights();
            }
            
            // Pressing ESC closes the UI if currently visible
            if (evt.key === "Escape") {
                // Only hide if this container is visible
                if (this.container.style.display === "flex") {
                    this.hide();
                }
            }
        });
        
        doc.addEventListener("keyup", (evt) => {
            if (evt.key === "Meta") {
                this.isMetaKeyHeld = false;
                this.updateButtonHighlights();
            }
        });
    }
    
    /**
    * Updates which button is highlighted when the user holds the ⌘ key.
    */
    private updateButtonHighlights(): void {
        const deepSearchBtn = this.container.querySelector(".deep-search-btn") as HTMLButtonElement;
        const sendBtn = this.container.querySelector(".send-btn") as HTMLButtonElement;
        
        if (this.isMetaKeyHeld) {
            // highlight the deep search
            deepSearchBtn.classList.add("highlighted-btn");
            deepSearchBtn.classList.remove("inactive-btn");
            sendBtn.classList.remove("highlighted-btn");
            sendBtn.classList.add("inactive-btn");
        } else {
            // highlight Send
            deepSearchBtn.classList.remove("highlighted-btn");
            deepSearchBtn.classList.add("inactive-btn");
            sendBtn.classList.add("highlighted-btn");
            sendBtn.classList.remove("inactive-btn");
        }
    }
    
    /**
    * Injects CSS styles for this UI element.
    */
    private injectStyles(): void {
        const doc = this.getGlobal("document");
        const style = this.ui.createElement(doc, "style", {
            id: "quick-chat-styles",
        }) as HTMLStyleElement;
        
        style.innerText = `
            /* Container */
            .quick-chat-container {
                flex-direction: column;
            }
            
            /* Input Container */
            .quick-chat-input-container {
                margin-bottom: 6px;
                margin-left: -3px;
            }
            .quick-chat-input {
                color: #888;
                width: calc(100% - 28px);
                font-size: 16px;
                padding: 10px 12px;
                border: 1px solid #333;
                background: #222;
                border-radius: 6px;
                margin-right:-2px;
                outline: none;
            }
            .quick-chat-input:focus {
                border-color: #333;
                box-shadow: 0 0 0 1px #333;
            }
            
            /* Items container */
            .quick-chat-sources-container {
                margin-bottom: 18px;
                min-height: 24px;
            }
            
            /* Item styling: like inline code/chips */
            .quick-chat-item {
                display: inline-block;
                margin: 4px 6px 4px 0;
                padding: 4px 6px;
                border-radius: 4px;
                border: 1px solid #444;
                background-color: #333;
                /* font-family: Consolas, monospace; */
                position: relative;
                cursor: default;
                color: #bbb;
                opacity: 0.6;
                transition: opacity 0.2s ease, background-color 0.2s ease, color 0.2s ease;
            }
            .quick-chat-item:hover {
                opacity: 0.8;
            }
            .remove-item-btn {
                color: #888;
                margin-left: 6px;
                cursor: pointer;
                font-weight: 400;
                transition: color 0.2s ease;
            }
            .remove-item-btn:hover {
                color: #eee;
            }
            
            /* Footer (instructions) */
            .quick-chat-buttons {
                display: flex;
                flex-direction: row;
                align-items: center;
                // border-top: 1px solid #eee;
                padding-top: 10px;
            }
            .quick-chat-buttons-left {
                display: flex;
                flex: 1;
            }
            .quick-chat-buttons-right {
                display: flex;
                gap: 6px; /* Smaller gap between the two buttons */
            }
            .quick-chat-esc-btn,
            .quick-chat-btn {
                border: 1px solid #ccc;
                background: #444;
                padding: 3px 4px;
                border-radius: 4px;
                border-color: #666;
                cursor: pointer;
                font-size: 12px;
                font-weight: 400;
                color: #c3c3c3;
                transition: background-color 0.2s ease, color 0.2s ease, opacity 0.2s ease;
            }

            .quick-chat-esc-btn:hover,
            .quick-chat-btn:hover {
                background: #444;
                color: #fff;
                font-weight: 400;
            }

            /* Highlight the 'active' button vs. inactive */
            .highlighted-btn {
                color: #d3d3d3;
                transition: color 0.2s ease;
            }
            .deep-search-btn{
                margin-right: 4px;
            }

            .inactive-btn {
                opacity: 0.4;
                transition: opacity 0.2s ease;
            }

            .inactive-btn:hover {
                opacity: 0.7;
            }

        `;
        
        doc.documentElement.appendChild(style);
    }
}
