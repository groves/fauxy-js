Fauxy proxies requests to a server.
The first time it sees a request, it records the response to disk and returns it.
From then on, it can return the recorded response whenever it sees the same request.

[axios-fauxy-interceptor](https://github.com/groves/fauxy-js/tree/main/axios-fauxy-interceptor) contains an implementation for [axios](https://github.com/axios/axios).
[fauxy-py](https://github.com/groves/fauxy) contains an ASGI implementation for Python.
All implementations use the same request matching logic, so recordings can be shared between them.

# Matching requests
To decide if a given request matches any recordings, fauxy creates a 'key' for the request.
It takes a `KeyMaker` function to do this.
The key maker takes in a request object with a url, the HTTP method, headers, and request body and returns a JSON key.
Any request that produces identical JSON will be considered a match by fauxy.

Here's a key maker that only matches on the request path:

```ts
(req: FauxyRequest) => ({ path: req.url.pathname })
```

If fauxy is proxying to example.com, that key maker will say any request to /1/2/3 has the key `{"path": "/1/2/3"}`
The first time fauxy sees it, it'll proxy that to example.com/1/2/3 and record the result.
Future requests for /1/2/3 will produce the same key regardless of other attributes of the request e.g. query parameters or HTTP method.
Since those keys match, fauxy will return the recording instead of proxying again.
If a request is then made for /1/2, it produces different JSON: `{"path": "/1/2"}`.
That means the existing recording won't be found and fauxy will proxy and record it.

# Storing responses
Fauxy writes out responses for all requests with a new key to the library directory you pass it.
Inside that directory, it creates a directory per recorded response.
The response directory is the full request path with a hash of the request key as its final segment.

For our /1/2/3 example, if the library directory is `recordings`, fauxy could produce the directory `recordings/1/2/3/ed142f966bc07648cc93e352a60119d328f7c189`.
In that example, `ed142f966bc07648cc93e352a60119d328f7c189` is the hash of the key JSON bytes.
When looking for a recording matching a request, fauxy produces the hash, walks the library directory, and returns the first matching hash directory it finds.

While the request path is part of the created directory structure, it doesn't constrain matching.
As long as the hash matches, fauxy will return a response.
If you include the requested path in the key JSON, the hash will be determined by the path, but if you don't, it won't affect it.

# TODO
* Add an implementation using [Mock Service Worker](https://mswjs.io/)
