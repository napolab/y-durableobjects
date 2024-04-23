import { createEncoder, writeVarUint } from "lib0/encoding";

export const messageType = {
  sync: 0,
  awareness: 1,
};

export const isMessageType = (
  type: string,
): type is keyof typeof messageType => {
  return Object.keys(messageType).includes(type);
};

export const createTypedEncoder = (type: keyof typeof messageType) => {
  if (!isMessageType(type)) {
    throw new Error(`Unsupported message type: ${type}`);
  }

  const encoder = createEncoder();
  writeVarUint(encoder, messageType[type]);

  return encoder;
};
