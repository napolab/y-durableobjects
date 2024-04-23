import { createDecoder, readVarUint } from "lib0/decoding";
import { toUint8Array } from "lib0/encoding";
import { describe, it, expect } from "vitest";

import { createTypedEncoder, messageType } from ".";

describe("createTypedEncoder", () => {
  // Define test cases for different message types
  const cases = [
    ["sync", messageType.sync],
    ["awareness", messageType.awareness],
  ] as const;

  it.each(cases)(
    "should initialize an encoder with the '%s' message type",
    (type, expectedCode) => {
      const encoder = createTypedEncoder(type);
      const uint8Array = toUint8Array(encoder);
      const decoder = createDecoder(uint8Array);
      const readType = readVarUint(decoder);

      expect(readType).toBe(expectedCode);
    },
  );

  // Optionally, test for handling invalid input keys if the function needs to handle such cases
  it("should throw an error for an invalid type key", () => {
    const invalidType = "invalidType";
    expect(() =>
      createTypedEncoder(invalidType as keyof typeof messageType),
    ).toThrowError();
  });
});
