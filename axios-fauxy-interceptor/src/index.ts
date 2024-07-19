import assert from "assert";
import { client } from "./client.js";

async function main(p0: number) {
  const resp = await client.get("http://localhost:8080/ping");
  console.log(p0, resp.data);
  return resp.data;
}
const [first, second] = await Promise.all([main(1), main(2)]);
assert(first === second);
