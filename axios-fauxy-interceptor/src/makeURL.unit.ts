import { describe, expect, it } from "vitest";
import { makeURL } from "../src/makeURL.js";
describe("makeURL", () => {
    it("handles no base", async () => {
        expect(makeURL({ url: "/" })).to.deep.equal(new URL("http://localhost"));
    });
    it("handles only base", async () => {
        expect(makeURL({ baseURL: "http://example.com/base" })).to.deep.equal(new URL("http://example.com/base"));
    });
    it("handles base and url", async () => {
        expect(makeURL({ url: "sub", baseURL: "http://example.com/base" })).to.deep.equal(new URL("http://example.com/base/sub"));
    });
    it("handles params", async () => {
        expect(makeURL({ url: "/", params: { foo: 1 } })).to.deep.equal(new URL("http://localhost?foo=1"));
    });
});
