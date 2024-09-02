import axios, {
  AxiosResponse,
  AxiosInstance,
  CreateAxiosDefaults,
  InternalAxiosRequestConfig,
  AxiosHeaders,
  AxiosRequestConfig,
} from "axios";
import { opendir, readFile, mkdir, writeFile } from "fs/promises";
import { Readable } from "stream";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { blake2b } from "hash-wasm";
import { URL } from "url";
import { STATUS_CODES } from "http";
import { buffer } from "stream/consumers";
import { pino } from "pino";
import {
  FauxyConfig,
  FauxyProxy,
  FauxyRequest,
  HeaderStabilizer,
} from "./types.js";

const logger = pino({ name: "fauxy" });

export function headerDeleter(
  headerName: string,
  ...additionalNames: string[]
): HeaderStabilizer {
  const headersToDelete = [headerName, ...additionalNames];
  return (headers: Headers) => {
    headersToDelete.forEach((name) => headers.delete(name));
  };
}

interface FauxyHashResult {
  proxy: FauxyProxy;
  hashed: string;
}

interface InternalFauxyConfig extends FauxyConfig {
  matched?: FauxyHashResult;
  resolved: URL;
}

interface InternalFauxyRequestConfig<D = any>
  extends InternalAxiosRequestConfig<D> {
  fauxy: InternalFauxyConfig;
}

interface FauxyAxiosResponse<R = any, D = any> extends AxiosResponse<R, D> {
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
export const isFauxyResponse = (
  resp: AxiosResponse,
): resp is FauxyAxiosResponse => {
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
  req: FauxyRequest,
  fauxy: FauxyConfig,
): Promise<FauxyHashResult | undefined> {
  for (const proxy of fauxy.proxies) {
    const key = await Promise.resolve(proxy.keyMaker(req));
    if (key === null) {
      continue;
    }

    const hashed = await blake2b(JSON.stringify(key, null, 2), 160);
    return { proxy, hashed };
  }
}

const runningInterceptors: {
  [key: string]: { promise: Promise<void>; resolver: () => void } | undefined;
} = {};
async function checkMatch(
  config: InternalFauxyRequestConfig,
  matched: FauxyHashResult,
) {
  const {
    proxy: { libraryDir },
    hashed,
  } = matched;
  const iter = await opendir(libraryDir, { recursive: true });
  for await (const entry of iter) {
    if (!entry.isDirectory() || entry.name !== hashed) {
      continue;
    }
    // Dirent.parentPath wasn't added till Node 18.20
    // From 18.17 through 18.19, Dirent.path was there instead.
    // It's deprecated with the addition of parentPath, so only use path in versions where
    // parentPath is undefined.
    const entryPath = entry.parentPath
      ? path.join(entry.parentPath, entry.name)
      : // Cast to silence the entry.path deprecation warning
        (entry as any).path;
    const metaPath = path.join(entryPath, "meta.json");
    const responsePath = path.join(entryPath, "response.content");

    let metaContent: string;
    try {
      metaContent = await readFile(metaPath, "utf-8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        if (runningInterceptors[hashed]) {
          return false;
        }
        logger.warn(
          { metaPath },
          "Recording directory exists but meta.json doesn't, recording",
          metaPath,
        );
        return true;
      }
      throw error;
    }

    const { status, headers } = JSON.parse(metaContent);
    if (!headers["Date"] && !headers["date"]) {
      headers["Date"] = new Date().toUTCString();
    }

    config.adapter = async () => {
      let data: string | Buffer | AsyncIterable<any>;
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
      return {
        status,
        statusText: STATUS_CODES[status] || "Unknown",
        headers,
        data,
        config,
      };
    };
    return true;
  }
  if (runningInterceptors[hashed]) {
    return false;
  } else {
    let resolver = () => {};
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    runningInterceptors[hashed] = { promise, resolver };
    return true;
  }
}

export function makeURL(config: AxiosRequestConfig): URL {
  const uri = axios.getUri(config);
  return new URL(uri, "http://localhost");
}

async function requestInterceptor<D>(
  config: InternalAxiosRequestConfig<D>,
): Promise<InternalAxiosRequestConfig<D>> {
  if (!isFauxyRequest(config) || config.fauxy.proxies.length === 0) {
    return config;
  }

  config.fauxy.resolved = makeURL(config);
  const headers = new Headers();

  for (const [key, value] of config.headers) {
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    } else if (value !== undefined && value !== null) {
      headers.set(key, value.toString());
    }
  }

  const req: FauxyRequest = {
    url: makeURL(config),
    method: (config.method ?? "GET").toUpperCase(),
    headers,
    data: config.data,
  };
  config.fauxy.matched = await hash(req, config.fauxy);
  if (!config.fauxy.matched) {
    return config;
  }

  while (true) {
    const runner = runningInterceptors[config.fauxy.matched.hashed];
    if (runner !== undefined) {
      await runner.promise;
    } else if (await checkMatch(config, config.fauxy.matched)) {
      break;
    }
  }
  return config;
}
async function record<T, D>(
  resp: AxiosResponse<T, D>,
  fauxy: InternalFauxyConfig,
  matched: FauxyHashResult,
): Promise<void> {
  if (!isAxiosHeaders(resp.headers)) {
    logger.warn(
      "headers isn't an AxiosHeaders object, don't know how to deal with it",
    );
    return;
  }

  const pathParts = fauxy.resolved.pathname.split("/").filter((s) => s !== "");
  const { proxy, hashed } = matched;
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
  for (const stabilizer of [
    ...(fauxy.headerStabilizers ?? []),
    ...(proxy.headerStabilizers ?? []),
  ]) {
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
}

async function responseInterceptor<T, D>(
  resp: AxiosResponse<T, D>,
): Promise<AxiosResponse<T, D>> {
  if (!isFauxyResponse(resp)) {
    return resp;
  }
  if (!resp.config.fauxy.matched) {
    logger.debug("Response not intercepted: fauxy.matched is undefined");
    return resp;
  }
  const hashed = resp.config.fauxy.matched.hashed;
  const recordPromise = runningInterceptors[hashed];
  if (recordPromise === undefined) {
    logger.debug("Replayed, skipping");
    return resp;
  }
  try {
    await record(resp, resp.config.fauxy, resp.config.fauxy.matched);
  } finally {
    recordPromise.resolver();
    delete runningInterceptors[hashed];
  }

  return resp;
}

export interface CreateFauxyDefaults<D = any> extends CreateAxiosDefaults<D> {
  fauxy: FauxyConfig;
}

export function create<D>(config?: CreateFauxyDefaults<D>): FauxyAxiosInstance {
  const axiosDefaultsWithFauxy = axios.defaults as typeof axios.defaults & {
    fauxy?: FauxyConfig;
  };
  if (!axiosDefaultsWithFauxy.fauxy) {
    axiosDefaultsWithFauxy.fauxy = {
      proxies: [],
      headerStabilizers: [headerDeleter("date")],
    };
  }
  const client = axios.create(config) as FauxyAxiosInstance;
  client.interceptors.request.use(requestInterceptor);
  client.interceptors.response.use(responseInterceptor);
  return client;
}
