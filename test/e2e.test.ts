import { env } from "cloudflare:test"

declare module "cloudflare:test" {
  interface ProvidedEnv {
    Y_DURABLE_OBJECTS: DurableObjectNamespace
  }
}

describe("Durable Objects", () => {
  it.skip("101", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId()
    const stub = env.Y_DURABLE_OBJECTS.get(id)
    const res = await stub.fetch("http://localhost/", {
      headers: {
        "upgrade": "websocket",
      }
    })
    expect(res.status).toBe(101)
  })

  it("426", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId()
    const stub = env.Y_DURABLE_OBJECTS.get(id)
    const res = await stub.fetch("http://localhost/")
    expect(res.status).toBe(426)
  })

  it.skip("accept", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId()
    const stub1 = env.Y_DURABLE_OBJECTS.get(id)

    const res = await stub1.fetch("http://localhost/", {
      headers: {
        "upgrade": "websocket",
      }
    })
    res.webSocket?.accept()
  })

  it.skip("sync", async () => {
    const id = env.Y_DURABLE_OBJECTS.newUniqueId()
    const stub1 = env.Y_DURABLE_OBJECTS.get(id)
    const stub2 = env.Y_DURABLE_OBJECTS.get(id)

    const res1 = await stub1.fetch("http://localhost/", {
      headers: {
        "upgrade": "websocket",
      }
    })
    res1.webSocket?.accept()
    const res2 = await stub2.fetch("http://localhost/", {
      headers: {
        "upgrade": "websocket",
      }
    })
    res2.webSocket?.accept()
  })
})