import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { ComponentProps } from "react";
import { WebsocketProvider } from "y-websocket";
import type { Provider } from "@lexical/yjs";
import { Doc } from "yjs";

const WS_URL = import.meta.env.PROD ? import.meta.env.VITE_WSS_URL : "ws://localhost:8787";

type Props = ComponentProps<typeof CollaborationPlugin>;
type ProviderFactory = Props["providerFactory"];

export const providerFactory: ProviderFactory = (id, map) => {
  const doc = new Doc();
  map.set(id, doc);

  const provider = new WebsocketProvider(new URL("/editor", WS_URL).href, id, doc);

  // 公式通りやると型エラーになる調査する
  return provider as unknown as Provider;
};
