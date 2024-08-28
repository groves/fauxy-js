import assert from "assert";
import { create, FauxyRequest } from "./index.js";

const client = create({
  fauxy: {
    proxies: [
      {
        keyMaker: (req: FauxyRequest) => ({ path: req.url.pathname }),
        libraryDir: "recordings",
      },
    ],
  },
});

async function ping(p0: number) {
  const resp = await client.get("http://localhost:8080/ping");
  console.log(p0, resp.data);
  return resp.data;
}
const [first, second] = await Promise.all([ping(1), ping(2)]);
assert(first === second);
