import { ChatMessage } from "react/types/messages";
import { fileToContentPart, urlToContentPart, APIMessage, ContentPart } from "./OpenAIProvider";
import { ZoteroAttachment } from "react/types/attachments";

const SYSTEM_PROMPT = `You are a helpful assistant that helps researchers answer questions related to research papers, reports, and other research-related documents.

Answer the users question using the provided documents as source materials. Keep your answer ground in the facts of the documents.

If the documents do not contain information to answer the question, clearly state that.

If there are no provided documents or materials, you can still answer the question based on your knowledge.

Follow these rules when refering to documents:
- Use the bibliographic information to refer to a specific document. For example, you can say "the article titled 'Research on AI'" or "John Doe argues that...".
- Support your statements with source citations that include document id(s) at the end of sentences or paragraphs following best citations practices for an academic researcher. Format citations using the following format:
    - For a single document: "[ID]"
    - For multiple documents: "[ID1, ID2, ID3]"
`

async function getNoteAsMarkdown(item: Zotero.Item) {
    const translation = new Zotero.Translate.Export();
    translation.setItems([item]);
    translation.setTranslator(Zotero.Translators.TRANSLATOR_ID_NOTE_MARKDOWN);
    let markdown = '';
    translation.setHandler("done", (obj: any, worked: boolean) => {
        if (worked) {
            markdown = obj.string.replace(/\r\n/g, '\n');
        }
    });
    await translation.translate();
    return markdown;
}


const getContentPartFromZoteroNote = async (item: Zotero.Item): Promise<ContentPart[]> => {
    // const content = await getNoteAsMarkdown(item);
    // @ts-ignore unescapeHTML exists
    const content = Zotero.Utilities.unescapeHTML(item.getNote());
    const title = item.getNoteTitle();
    
    return [
        {
            type: 'text',
            text: `id: ${item.key}\ntype: Note\nname: ${title}\n\n${content}`
        }
    ];
}

const getContentPartFromZoteroItem = async (item: Zotero.Item, name: string): Promise<ContentPart[]> => {
    if(item.isNote()) {
        return await getContentPartFromZoteroNote(item);
    }
    if(item.isAttachment()) {
        const filePath = item ? await item.getFilePath() : undefined;
        if(filePath) {
            return [
                {
                    type: 'text',
                    text: `id: ${item.key}\ntype: Document\nReference: ${name}`
                },
                await fileToContentPart(filePath)
            ];
        }
    }
    return [];
}

const getContentPartFromZoteroAttachment = async (attachment: ZoteroAttachment): Promise<ContentPart[]> => {
    const item = attachment.item;

    // If the attachment has defined child items, get the content of the child items
    if(attachment.childItemIds) {
        const childItems = attachment.childItemIds.map(id => Zotero.Items.get(id));
        const childItemsContent = await Promise.all(childItems.map(item => getContentPartFromZoteroItem(item, attachment.fullName)));
        return childItemsContent.flat();
    }

    // Get the effective item to use for content extraction
    const effectiveItem: Zotero.Item | false = item.isRegularItem() ? await item.getBestAttachment() : item;
    if(!effectiveItem || effectiveItem.isRegularItem()) return [];

    return await getContentPartFromZoteroItem(effectiveItem, attachment.fullName);
}


const chatMessageToRequestMessage = async (message: ChatMessage): Promise<APIMessage> => {
    if (message.role === 'user') {
        
        // Convert attachments to content parts
        const attachmentsContent: ContentPart[] = [];
        for (const attachment of message.attachments || []) {
            switch (attachment.type) {
                case 'zotero_item': {
                    const contentParts = await getContentPartFromZoteroAttachment(attachment);
                    attachmentsContent.push(...contentParts);
                    break;
                }
                case 'file':
                    // if (attachment.filePath) {
                    //     const contentPart = await fileToContentPart(attachment.filePath);
                    //     if (contentPart) {
                    //         attachmentsContent.push(contentPart);
                    //     }
                    // }
                    break;
                case 'remote_file':
                    attachmentsContent.push(urlToContentPart(attachment.url));
                    break;
                default:
                    break;
            }
        }
        
        // Add the user's message
        const content: ContentPart[] = [
            ...attachmentsContent,
            {
                type: 'text',
                text: message.content
            }
        ];
        
        return {
            role: message.role,
            content: content
        };
    }

    // For non-user messages, return as is
    return {
        role: message.role,
        content: message.content
    };
}

export const chatCompletion = async (
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onFinish: () => void,
    onError: (error: Error) => void
) => {
    // LLM provider
    // @ts-ignore Zotero.Beaver defined in hooks.ts
    const provider = Zotero.Beaver.aiProvider;
    const model = (provider.providerName === 'openai') ? 'gpt-4o' : 'gemini-2.0-flash';

    // Request messages 
    const requestMessages = [
        {
            role: 'system',
            content: SYSTEM_PROMPT
        },
        ...(await Promise.all(messages.map(chatMessageToRequestMessage))),
    ];

    console.log('requestMessages', requestMessages);
    
    const request = {
        model: model,
        messages: requestMessages,
    }

    // Call chat completion
    try {
        // const response = await provider.createChatCompletion(request);    
        await provider.createChatCompletionStreaming(request, onChunk);
    } catch (error) {
        console.error(error);
        onError(error as Error);
    }

    // Call finish callback
    onFinish();
}