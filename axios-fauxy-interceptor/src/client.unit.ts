import { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { describe, expect, it, test } from "vitest";
import {
  create,
  headerDeleter,
  isAxiosHeaders,
  isFauxyResponse,
} from "../src/client.js";
import { readFile, rm } from "fs/promises";
import { join } from "path";
import { FauxyRequest } from "./types.js";

const dummyAdapter = <T,>(data: T, status = 200) => {
  return async (
    config: InternalAxiosRequestConfig,
  ): Promise<AxiosResponse<T>> => {
    return {
      data,
      status,
      statusText: status === 200 ? "200 OK" : "500 Internal Server Error",
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
const nameKey = (req: FauxyRequest) => ({
  path: req.url.pathname,
});

const pathFauxy = {
  adapter: dummyAdapter(true),
  fauxy: {
    proxies: [
      {
        keyMaker: nameKey,
        libraryDir: "recordings",
        headerStabilizers: [headerDeleter("OnlyInLive")],
      },
    ],
  },
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
    const nameDir = join(__dirname, "../recordings/rerecord");
    await rm(nameDir, { recursive: true, force: true });

    const client = create(pathFauxy);
    const resp = await client.get("http://localhost/rerecord");
    expect(resp.data).to.equal(true);
    expect(resp.headers["OnlyInLive"]).to.equal("I'm here!");
    if (isFauxyResponse(resp)) {
      if (resp.config.fauxy.matched !== undefined) {
        const metaPath = join(
          nameDir,
          resp.config.fauxy.matched.hashed,
          "meta.json",
        );
        const metaContent = await readFile(metaPath, "utf-8");
        const { headers } = JSON.parse(metaContent);
        expect(headers).to.have.property("Content-Type");
        expect(headers).to.not.have.property("Date");
        expect(headers).to.not.have.property("OnlyInLive");
      } else {
        expect.fail("Fauxy should've matched, but it's undefined");
      }
    } else {
      expect.fail("Resp should be a fauxy response");
    }

    const respWithRecording = await client.get("http://localhost/rerecord", {
      adapter: dummyAdapter(false),
    });
    expect(respWithRecording.data).to.equal(true);
    if (isAxiosHeaders(respWithRecording.headers)) {
      expect(respWithRecording.headers.get("OnlyInLive")).to.be.undefined;
    } else {
      expect.fail("Headers should be AxiosHeaders");
    }
    expect(resp.headers["Date"]).to.be.a("string");
  });
  it("replay recordings", async () => {
    const client = create(pathFauxy);
    const resp = await client.get("http://localhost/replacedwithfalse");
    // We have false in the recording, so if we don't replay it, we'll get the true from the adapter
    expect(resp.data).to.equal(false);

    expect(resp.headers["Date"]).to.be.a("string");
    const headerDate = new Date(resp.headers["Date"]);

    const timeDifference = new Date().getTime() - headerDate.getTime();
    expect(timeDifference).to.be.lessThan(1000); // Less than 1 second
  });

  it("handles parallel requests correctly", async () => {
    const nameDir = join(__dirname, "../recordings/parallel");
    await rm(nameDir, { recursive: true, force: true });
    const client = create(pathFauxy);
    const [resp1, resp2] = await Promise.all([
      client.get("http://localhost/parallel"),
      client.get("http://localhost/parallel", { adapter: dummyAdapter(false) }),
    ]);

    // We don't know which of the above two will execute first and fill the cache.
    // However, whichever executes first, we expect the one that goes second will get its value.
    // So these responses should be the same...
    expect(resp1.data).to.equal(resp2.data);

    // Because it can change which returns first, we delete the recording to squash spurious diffs
    await rm(nameDir, { recursive: true, force: true });
  });

  it("records and replays 500 status correctly", async () => {
    const nameDir = join(__dirname, "../recordings/error500");
    await rm(nameDir, { recursive: true, force: true });

    const client = create(pathFauxy);

    const adapter = dummyAdapter({ error: "Internal Server Error" }, 500);
    const resp = await client.get("http://localhost/error500", {
      adapter,
    });
    expect(resp.status).to.equal(500);
    expect(resp.data).to.deep.equal({ error: "Internal Server Error" });

    const replayResp = await client.get("http://localhost/error500");
    expect(replayResp.status).to.equal(500);
    expect(replayResp.data).to.deep.equal({ error: "Internal Server Error" });
  });
});
