import { describe, expect, it } from "vitest";
import { FauxyRequestConfig, create } from "../src/client.js";

describe("Fauxy interceptors", () => {
  it("don't get in the way without proxying", async () => {
    const client = create();
    const resp = await client.get("http://localhost:8080/ping", {});
    expect(resp.data).to.match(/pong \d+\n/);
  });
  it("replay recordings", async () => {
    const client = create({
      fauxy: {
        proxies: [
          {
            keyMaker: (config: FauxyRequestConfig) => ({
              path: config.url ?? null,
            }),
            libraryDir: "recordings",
            headerProcessors: [],
          },
        ],
      },
    });
    const resp = await client.get("http://localhost:8080/ping", {});
    expect(resp.data).to.equal("pong 0\n");
  });
});
