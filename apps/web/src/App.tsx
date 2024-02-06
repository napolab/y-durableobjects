import { ListItemNode, ListNode } from "@lexical/list";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import { InitialConfigType, LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import LexicalErrorBoundary from "@lexical/react/LexicalErrorBoundary";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { ComponentProps } from "react";
import { theme } from "./theme";
import { TRANSFORMERS } from "@lexical/markdown";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";

function Editor() {
  const initialConfig: InitialConfigType = {
    editorState: null,
    namespace: "Demo",
    nodes: [
      ListNode,
      ListItemNode,
      LinkNode,
      AutoLinkNode,
      TableNode,
      TableCellNode,
      TableRowNode,
      HeadingNode,
      QuoteNode,
      CodeNode,
      CodeHighlightNode,
    ],
    onError: (error: Error) => {
      throw error;
    },
    theme,
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={<ContentEditable />}
        placeholder={<div>Enter some text...</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin />
      <TablePlugin />
      <TabIndentationPlugin />
      <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
      <CollaborationPlugin
        id=""
        username={crypto.randomUUID()}
        providerFactory={(id, yjsDocMap) => {
          const doc = new Y.Doc();
          yjsDocMap.set(id, doc);

          const provider = new WebsocketProvider(
            "wss://worker.yjs.napochaan.dev",
            // "ws://localhost:8787",
            id,
            doc,
          );

          // 公式通りやると型エラーになる調査する
          return provider as unknown as ReturnType<ComponentProps<typeof CollaborationPlugin>["providerFactory"]>;
        }}
        shouldBootstrap={true}
      />
    </LexicalComposer>
  );
}

export default Editor;
