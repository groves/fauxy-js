import { describe, expect, it } from "vitest";
import { create } from "../src/client.js";
import path from "path";
import { readFile } from "fs/promises";
import { buffer } from "stream/consumers";
import { Axios } from "axios";
import { FauxyRequest } from "./types.js";

const pathKey = (req: FauxyRequest) => ({ path: req.url.pathname });
const pathProxy = { libraryDir: "recordings", keyMaker: pathKey };
const noFauxy = {
  baseURL: "http://localhost:8080",
  fauxy: { proxies: [] },
};
const pathFauxy = {
  baseURL: "http://localhost:8080",

  fauxy: { proxies: [pathProxy] },
};
async function runPdfGauntlet(client: Axios) {
  const pdfPath = path.resolve(__dirname, "../../test-server/minimal.pdf");

  const stringPdf = await readFile(pdfPath, { encoding: "utf8" });
  const defaultResp = await client.get("minimal.pdf");
  expect(defaultResp.data).to.equal(stringPdf);

  // This is a nonsense call, but we want to make sure we stay compatible with what Axios does with it
  // (which is to create a string from the response)
  const jsonResp = await client.get("minimal.pdf", { responseType: "json" });
  expect(jsonResp.data).to.equal(stringPdf);

  const bufferPdf = await readFile(pdfPath);
  const streamResp = await client.get("minimal.pdf", {
    responseType: "stream",
  });
  const bufferData = await buffer(streamResp.data);
  expect(bufferData).to.deep.equal(bufferPdf);

  const bufferResp = await client.get("minimal.pdf", {
    responseType: "arraybuffer",
  });
  expect(bufferResp.data).to.deep.equal(bufferPdf);
}
describe("Fauxy interceptors", () => {
  it("don't get in the way without proxying", async () => {
    const client = create(noFauxy);
    const resp = await client.get("/ping");
    expect(resp.data).to.match(/pong \d+/);
  });
  it("replay recordings", async () => {
    const client = create(pathFauxy);
    const resp = await client.get("ping");
    expect(resp.data).to.equal("pong 0");
  });
  it("replays non-json", async () => {
    await runPdfGauntlet(create(pathFauxy));
  });
  it("don't get in the way of non-json", async () => {
    await runPdfGauntlet(create(noFauxy));
  });
});
