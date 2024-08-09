import { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { describe, expect, it } from "vitest";
import {
  FauxyProxy,
  InternalFauxyRequestConfig,
  create,
  headerDeleter,
  isAxiosHeaders,
} from "../src/client.js";
import { rm } from "fs/promises";
import { join } from "path";

const dummyAdapter = <T,>(data: T) => {
  return async (
    config: InternalAxiosRequestConfig,
  ): Promise<AxiosResponse<T>> => {
    // TODO check response code as we can't use settle
    return {
      data,
      status: 200,
      statusText: "200 OK",
      headers: {
        "Content-Type": "application/json",
        Date: new Date().toUTCString(),
        OnlyInLive: "I'm here!",
      },
      config,
      request: {},
    };
  };
};
const nameKey = (config: InternalFauxyRequestConfig) => {
  return {
    path: config.fauxy.resolved.pathname,
  };
};
const pathProxy: FauxyProxy = {
  keyMaker: nameKey,
  libraryDir: "recordings",
  headerStabilizers: [],
};

const pathFauxy = {
  adapter: dummyAdapter(true),
  fauxy: { proxies: [pathProxy] },
};

describe("Fauxy interceptors", () => {
  it("don't get in the way without proxying", async () => {
    const client = create();
    const resp = await client.get("http://localhost", {
      adapter: dummyAdapter(true),
    });
    expect(resp.data).to.equal(true);
  });
  it("record", async () => {
    const previous = join(__dirname, "../recordings/rerecord");
    await rm(previous, { recursive: true, force: true });

    const client = create({
      adapter: dummyAdapter(true),
      fauxy: {
        proxies: [
          new FauxyProxy("recordings", nameKey, [headerDeleter("OnlyInLive")]),
        ],
      },
    });
    const resp = await client.get("http://localhost/rerecord");
    expect(resp.data).to.equal(true);
    expect(resp.headers["OnlyInLive"]).to.equal("I'm here!");

    const respWithRecording = await client.get("http://localhost/rerecord", {
      adapter: dummyAdapter(false),
    });
    expect(respWithRecording.data).to.equal(true);
    if (isAxiosHeaders(respWithRecording.headers)) {
      expect(respWithRecording.headers.get("OnlyInLive")).to.be.undefined;
    } else {
      expect.fail("Headers should be AxiosHeaders");
    }
  });
  it("replay recordings", async () => {
    const client = create(pathFauxy);
    const resp = await client.get("http://localhost/replacedwithfalse");
    // We have false in the recording, so if we don't replay it, we'll get the true from the adapter
    expect(resp.data).to.equal(false);
  });
});
