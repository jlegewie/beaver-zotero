// placeholder illustration
export const chatPaneHTML = `
    <vbox id="beaver-chat-inner" flex="1">
        <description>Type questions here:</description>
        <textbox id="beaver-chat-input" multiline="true" flex="0"/>
        <button id="beaver-chat-send">Send</button>
        <vbox id="beaver-chat-history" flex="1" style="border: 1px solid gray; overflow:auto;">
            <!-- messages appended dynamically -->
        </vbox>
    </vbox>
`;
