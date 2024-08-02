import { describe, expect, it } from "vitest";
import { InternalFauxyRequestConfig, create } from "../src/client.js";

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
            keyMaker: (config: InternalFauxyRequestConfig) => {
              return {
                path: config.fauxy.resolved.pathname,
              };
            },
            libraryDir: "recordings",
            headerProcessors: [],
          },
        ],
      },
    });
    const resp = await client.get("ping", {
      baseURL: "http://localhost:8080",
    });
    expect(resp.data).to.equal("pong 0\n");
  });
});
