import {
  Doc,
  applyUpdate,
  diffUpdate,
  encodeStateAsUpdate,
  encodeStateVectorFromUpdate,
  mergeUpdates,
} from "yjs";

describe("yDoc update", () => {
  it("single update", () => {
    const doc1 = new Doc();
    const doc2 = new Doc();

    doc1.getArray("root").insert(0, ["Hello doc2, you got this?"]);
    const update = encodeStateAsUpdate(doc1);

    applyUpdate(doc2, update);

    expect(encodeStateAsUpdate(doc1)).toEqual(encodeStateAsUpdate(doc2));
    expect(doc1.getArray("root").toArray()).toEqual(
      doc2.getArray("root").toArray(),
    );
  });

  it("some update", async () => {
    const doc1 = new Doc();
    const doc2 = new Doc();
    const doc3 = new Doc();
    const updates: Uint8Array[] = [];

    doc1.transact(() => {
      doc1.getArray("arr").insert(0, ["insert1"]);
      doc1.getText("text").insert(0, "Hello World");
      updates.push(encodeStateAsUpdate(doc1));
    });

    doc2.transact(() => {
      doc2.getArray("arr").insert(0, ["insert1", "insert2"]);
      doc2.getText("text").insert(0, "Hello2 World2");
      updates.push(encodeStateAsUpdate(doc2));
    });

    const update = mergeUpdates(updates);
    applyUpdate(doc3, update);

    console.log(doc3.getArray("arr").toArray());
    expect(updates).toEqual([
      encodeStateAsUpdate(doc1),
      encodeStateAsUpdate(doc2),
    ]);
    expect(update).toEqual(encodeStateAsUpdate(doc3));
  });

  it("diff update", () => {
    const remote = new Doc();
    remote.getText("root").insert(0, "Hello World");
    const state1 = encodeStateAsUpdate(remote);
    const vector1 = encodeStateVectorFromUpdate(state1);

    const client = new Doc();
    client.getText("root").insert(0, "Hello2 World2");
    const state2 = encodeStateAsUpdate(client);
    client.destroy();

    const diff2 = diffUpdate(state2, vector1);

    const update = mergeUpdates([state1, diff2]);
    applyUpdate(remote, update);
    console.log(update);

    console.log(remote.getText("root").toString());
  });
});
