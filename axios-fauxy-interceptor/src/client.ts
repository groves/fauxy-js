import axios, {
  AxiosRequestConfig,
  AxiosResponse,
  AxiosInstance,
  CreateAxiosDefaults,
  InternalAxiosRequestConfig,
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
}

export interface FauxyRequestConfig<D = any> extends AxiosRequestConfig<D> {
  fauxy: FauxyConfig;
}

export interface InternalFauxyConfig extends FauxyConfig {
  matchedProxy?: FauxyHashResult;
  replayed: boolean;
}

export interface InternalFauxyRequestConfig<D = any>
  extends InternalAxiosRequestConfig<D> {
  fauxy: InternalFauxyConfig;
}

export interface FauxyAxiosResponse<R = any, D = any>
  extends AxiosResponse<R, D> {
  config: InternalFauxyRequestConfig<D>;
}

export interface FauxyAxiosInstance extends Omit<AxiosInstance, "defaults"> {
  defaults: AxiosInstance["defaults"] & {
    fauxy?: FauxyConfig;
  };
}

const isErrnoException = (error: any): error is NodeJS.ErrnoException => {
  return (
    error instanceof Error &&
    ("errno" in error ||
      "code" in error ||
      "path" in error ||
      "syscall" in error)
  );
};

const isFauxyRequest = (
  config: InternalAxiosRequestConfig,
): config is InternalFauxyRequestConfig => {
  return "fauxy" in config;
};

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
  config: InternalAxiosRequestConfig<D>,
): Promise<InternalAxiosRequestConfig<D>> {
  if (!isFauxyRequest(config)) {
    return config;
  }

  config.fauxy.matchedProxy = await hash(config, config.fauxy);
  if (!config.fauxy.matchedProxy) {
    return config;
  }
  const { libraryDir, hashed } = config.fauxy.matchedProxy;
  const iter = await opendir(libraryDir, { recursive: true });
  for await (const entry of iter) {
    if (!entry.isDirectory() || entry.name !== hashed) {
      continue;
    }
    const entryPath = path.join(entry.parentPath, entry.name);
    const metaPath = path.join(entryPath, "meta.json");
    const responsePath = path.join(entryPath, "response.content");

    let metaContent;
    try {
      metaContent = await readFile(metaPath, "utf-8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        // TODO - wait for possible active recorder
        console.log(`${metaPath} doesn't exist, recording`);
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
      config.fauxy.replayed = true;
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

const isFauxyResponse = (resp: AxiosResponse): resp is FauxyAxiosResponse => {
  return "fauxy" in resp.config;
};

async function responseInterceptor<T, D>(
  resp: AxiosResponse<T, D>,
): Promise<AxiosResponse<T, D>> {
  if (!isFauxyResponse(resp)) {
    return resp;
  }
  if (!resp.config.fauxy.matchedProxy) {
    console.log("Response not intercepted: fauxy.matchedProxy is undefined");
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
  const { libraryDir, hashed } = resp.config.fauxy.matchedProxy;
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
      (resp.data as Readable).pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } else {
    // If it's an object (e.g., parsed JSON), stringify it
    await writeFile(contentPath, JSON.stringify(resp.data), "utf8");
  }

  return resp;
}

export interface CreateFauxyDefaults<D = any> extends CreateAxiosDefaults<D> {
  fauxy: FauxyConfig;
}

export function create<D>(config?: CreateFauxyDefaults<D>): FauxyAxiosInstance {
  if (!config) {
    config = { fauxy: { proxies: [] } };
  }
  const client = axios.create(config);
  client.interceptors.request.use(requestInterceptor);
  client.interceptors.response.use(responseInterceptor);
  return client;
}
