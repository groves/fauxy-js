import { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";
import { FauxyRequestConfig, create } from "./client.js";

const dummyAdapter = async (
  config: InternalAxiosRequestConfig,
): Promise<AxiosResponse<boolean>> => {
  // TODO check response code as we can't use settle
  return {
    data: true,
    status: 200,
    statusText: "200 OK",
    headers: {
      "Content-Type": "application/json",
    },
    config,
    request: {},
  };
};
describe("Fauxy interceptors", () => {
  it("don't get in the way without proxying", async () => {
    const client = create();
    const resp = await client.get("http://localhost", {
      adapter: dummyAdapter,
    });
    expect(resp.data).to.equal(true);
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
    const resp = await client.get("http://localhost", {
      adapter: dummyAdapter,
    });
    // We have false in the recording, so if we don't replay it, we'll get the true from the adapter
    expect(resp.data).to.equal(false);
  });
});
