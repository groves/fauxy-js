import axios, {
  AxiosRequestConfig,
  AxiosResponse,
  AxiosInstance,
  CreateAxiosDefaults,
  InternalAxiosRequestConfig,
  AxiosHeaders,
} from "axios";
import { opendir, readFile, mkdir, writeFile } from "fs/promises";
import { Readable } from "stream";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { blake2b } from "hash-wasm";
import { URL } from "url";
import { STATUS_CODES } from "http";
import { makeURL } from "./makeURL.js";
import { buffer } from "stream/consumers";
import { pino } from "pino";

const logger = pino({ name: "fauxy" });

type AnyJson = boolean | number | string | null | JsonArray | JsonObject;
interface JsonArray extends Array<AnyJson> {}
interface JsonObject {
  [key: string]: AnyJson;
}

type KeyMaker =
  | ((config: InternalFauxyRequestConfig) => JsonObject | null)
  | ((config: InternalFauxyRequestConfig) => Promise<JsonObject | null>);

type HeaderStabilizer = (headers: Headers) => void;

export function headerDeleter(
  headerName: string,
  ...additionalNames: string[]
): HeaderStabilizer {
  const headersToDelete = [headerName, ...additionalNames];
  return (headers: Headers) => {
    headersToDelete.forEach((name) => headers.delete(name));
  };
}

export class FauxyProxy {
  keyMaker: KeyMaker;
  libraryDir: string;
  headerStabilizers: HeaderStabilizer[];

  constructor(
    libraryDir: string,
    keyMaker: KeyMaker,
    headerStabilizers: HeaderStabilizer[] = [],
    addDefaultHeaderStabilizer: boolean = true,
  ) {
    this.libraryDir = libraryDir;
    this.keyMaker = keyMaker;

    this.headerStabilizers = addDefaultHeaderStabilizer
      ? [...headerStabilizers, headerDeleter("date")]
      : headerStabilizers;
  }
}

export interface FauxyHashResult {
  proxy: FauxyProxy;
  hashed: string;
}

export interface FauxyConfig {
  proxies: FauxyProxy[];
}

export interface FauxyRequestConfig<D = any> extends AxiosRequestConfig<D> {
  fauxy: FauxyConfig;
}

export interface InternalFauxyConfig extends FauxyConfig {
  matched?: FauxyHashResult;
  replayed: boolean;
  resolved: URL;
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

const isFauxyRequest = (
  config: InternalAxiosRequestConfig,
): config is InternalFauxyRequestConfig => {
  return "fauxy" in config;
};
const isFauxyResponse = (resp: AxiosResponse): resp is FauxyAxiosResponse => {
  return "fauxy" in resp.config;
};

export const isAxiosHeaders = (
  headers: AxiosResponse["headers"],
): headers is AxiosHeaders => {
  return "setContentType" in headers;
};

const isErrnoException = (error: any): error is NodeJS.ErrnoException => {
  return (
    error instanceof Error &&
    ("errno" in error ||
      "code" in error ||
      "path" in error ||
      "syscall" in error)
  );
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
    return { proxy, hashed };
  }
}

async function requestInterceptor<D>(
  config: InternalAxiosRequestConfig<D>,
): Promise<InternalAxiosRequestConfig<D>> {
  if (!isFauxyRequest(config)) {
    return config;
  }

  config.fauxy.resolved = makeURL(config);
  config.fauxy.matched = await hash(config, config.fauxy);
  if (!config.fauxy.matched) {
    return config;
  }
  const {
    proxy: { libraryDir },
    hashed,
  } = config.fauxy.matched;
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
        logger.warn(
          { metaPath },
          "Recording directory exists but meta.json doesn't, recording",
          metaPath,
        );
        return config;
      }
      throw error;
    }

    const { status, headers } = JSON.parse(metaContent);
    // TODO: set Date if not present

    config.adapter = async () => {
      let data;
      if (
        config.responseType === "stream" ||
        config.responseType == "arraybuffer"
      ) {
        data = createReadStream(responsePath);
        if (config.responseType == "arraybuffer") {
          data = await buffer(data);
        }
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

async function responseInterceptor<T, D>(
  resp: AxiosResponse<T, D>,
): Promise<AxiosResponse<T, D>> {
  if (!isFauxyResponse(resp)) {
    return resp;
  }
  if (!resp.config.fauxy.matched) {
    logger.debug("Response not intercepted: fauxy.matchedProxy is undefined");
    return resp;
  }
  if (resp.config.fauxy.replayed) {
    logger.debug("Replayed, skipping");
    return resp;
  }
  if (!isAxiosHeaders(resp.headers)) {
    logger.warn(
      "headers isn't an AxiosHeaders object, don't know how to deal with it",
    );
    return resp;
  }

  if (!resp.config.url) {
    logger.warn(
      "url missing on config, but supposed to be present when a request is active. Skipping fauxy",
    );
    return resp;
  }

  const pathParts = resp.config.fauxy.resolved.pathname
    .split("/")
    .filter((s) => s !== "");
  const { proxy, hashed } = resp.config.fauxy.matched;
  const fullPath = path.join(proxy.libraryDir, ...pathParts, hashed);
  await mkdir(fullPath, { recursive: true });

  let stabilizedHeaders = new Headers();
  const headerCaseMap: { [key: string]: string } = {};

  for (const [key, value] of resp.headers) {
    headerCaseMap[key.toLowerCase()] = key;
    if (Array.isArray(value)) {
      value.forEach((v) => stabilizedHeaders.append(key, v));
    } else if (value !== undefined && value !== null) {
      stabilizedHeaders.set(key, value.toString());
    }
  }

  for (const stabilizer of proxy.headerStabilizers) {
    stabilizer(stabilizedHeaders);
  }

  const headers: { [key: string]: string } = {};
  stabilizedHeaders.forEach((value, key) => {
    headers[headerCaseMap[key.toLowerCase()] || key] = value;
  });

  await writeFile(
    path.join(fullPath, "meta.json"),
    JSON.stringify({ status: resp.status, headers }, null, 2),
  );

  // Write response.content file
  const contentPath = path.join(fullPath, "response.content");
  if (Buffer.isBuffer(resp.data)) {
    await writeFile(contentPath, resp.data);
  } else if (typeof resp.data === "string") {
    // TODO handle incoming encoding
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
