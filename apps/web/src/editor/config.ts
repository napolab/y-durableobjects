import { ListItemNode, ListNode } from "@lexical/list";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import { InitialConfigType } from "@lexical/react/LexicalComposer";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { CodeNode, CodeHighlightNode } from "@lexical/code";
import { theme } from "./theme";

export const initialConfig: InitialConfigType = {
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
