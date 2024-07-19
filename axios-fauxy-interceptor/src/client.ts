import axios, {
  AxiosRequestConfig,
  AxiosResponse,
  AxiosResponseHeaders,
} from "axios";
import { opendir, readFile, mkdir, writeFile } from "fs/promises";
import { Readable } from "stream";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { blake2b } from "hash-wasm";
import { URL } from "url";
import { STATUS_CODES } from "http";

type AnyJson = boolean | number | string | null | JsonArray | JsonObject;
interface JsonArray extends Array<AnyJson> {}
interface JsonObject {
  [key: string]: AnyJson;
}

type KeyMaker =
  | ((config: FauxyRequestConfig) => JsonObject | null)
  | ((config: FauxyRequestConfig) => Promise<JsonObject | null>);

export interface FauxyProxy {
  keyMaker: KeyMaker;
  libraryDir: string;
  headerProcessors: object[];
}

export interface FauxyHashResult {
  libraryDir: string;
  hashed: string;
}

export interface FauxyConfig {
  proxies: FauxyProxy[];
  found?: FauxyHashResult;
  replayed: boolean;
}

export interface FauxyRequestConfig<D = any> extends AxiosRequestConfig<D> {
  fauxy?: FauxyConfig;
}

export interface FauxyAxiosResponse<R = any, D = any>
  extends AxiosResponse<R, D> {
  config: InternalFauxyRequestConfig<D>;
}

export interface InternalFauxyRequestConfig<D = any>
  extends FauxyRequestConfig<D> {
  headers: AxiosResponseHeaders;
}

async function hash(
  config: InternalFauxyRequestConfig,
  fauxy: FauxyConfig,
): Promise<FauxyHashResult | undefined> {
  for (const proxy of fauxy.proxies) {
    const key = await Promise.resolve(proxy.keyMaker(config));
    if (key === null) {
      continue;
    }

    const hashed = await blake2b(JSON.stringify(key, null, 2), 160);
    return { libraryDir: proxy.libraryDir, hashed };
  }
}

async function requestInterceptor<D>(
  config: InternalFauxyRequestConfig<D>,
): Promise<InternalFauxyRequestConfig<D>> {
  const fauxy = config.fauxy;
  if (!fauxy) {
    return config;
  }
  fauxy.found = await hash(config, fauxy);
  if (!fauxy.found) {
    return config;
  }
  const { libraryDir, hashed } = fauxy.found;
  const iter = await opendir(libraryDir, { recursive: true });
  for await (const entry of iter) {
    if (!entry.isDirectory() || entry.name !== hashed) {
      continue;
    }
    const entryPath = path.join(libraryDir, entry.name);
    const metaPath = path.join(entryPath, "meta.json");
    const responsePath = path.join(entryPath, "response.content");

    let metaContent;
    try {
      metaContent = await readFile(metaPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        // TODO - wait for possible active recorder
        console.log(`${metaPath} not found, rerecording`);
        return config;
      }
      throw error;
    }

    const { status, headers } = JSON.parse(metaContent);

    config.adapter = async () => {
      let data;
      if (config.responseType === "stream") {
        data = createReadStream(responsePath);
      } else {
        data = await readFile(responsePath, "utf-8");
      }
      fauxy.replayed = true;
      return {
        status,
        statusText: STATUS_CODES[status] || "Unknown",
        headers,
        data,
        config,
      };
    };
    break;
  }
  return config;
}

async function responseInterceptor<T, D>(
  resp: FauxyAxiosResponse<T, D>,
): Promise<FauxyAxiosResponse<T, D>> {
  if (!resp.config.fauxy?.found) {
    console.log("Response not intercepted: fauxy.found is undefined");
    return resp;
  }
  if (resp.config.fauxy.replayed) {
    console.log("Replayed, skipping");
    return resp;
  }
  if (!resp.config.url) {
    console.log(
      "url missing on config, but supposed to be present when a request is active. Skipping fauxy",
    );
    return resp;
  }

  const pathParts = new URL(resp.config.url).pathname
    .split("/")
    .filter((s) => s !== "");
  const { libraryDir, hashed } = resp.config.fauxy.found;
  const fullPath = path.join(libraryDir, ...pathParts, hashed);
  await mkdir(fullPath, { recursive: true });

  const metaData = {
    status: resp.status,
    headers: resp.headers,
  };
  await writeFile(
    path.join(fullPath, "meta.json"),
    JSON.stringify(metaData, null, 2),
  );

  // Write response.content file
  const contentPath = path.join(fullPath, "response.content");
  if (Buffer.isBuffer(resp.data)) {
    await writeFile(contentPath, resp.data);
  } else if (typeof resp.data === "string") {
    await writeFile(contentPath, resp.data, "utf8");
  } else if (resp.data instanceof Readable) {
    const writer = createWriteStream(contentPath);
    await new Promise((resolve, reject) => {
      resp.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } else {
    // If it's an object (e.g., parsed JSON), stringify it
    await writeFile(contentPath, JSON.stringify(resp.data), "utf8");
  }

  return resp;
}

export const client = axios.create();
client.interceptors.request.use(requestInterceptor);
client.interceptors.response.use(responseInterceptor);
