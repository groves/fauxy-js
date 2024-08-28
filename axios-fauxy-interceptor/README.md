Records requests through [Axios](https://axios-http.com/) if they haven't been seen before or replays them otherwise.

To use, call `create` to make an Axios instance with the fauxy interceptors installed:

```ts
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
```

If we're running [this server](https://github.com/groves/fauxy-js/blob/main/test-server/src/index.ts) that returns an incremented number on each fetch of `/ping`,
this will print the following:

```
1 pong 0
2 pong 0
```

It gets `0` for both ping fetches as the first request gets the initial value from the server and records it and the second request uses that recording.

