// These types should be independent of Axios. We'd like to use KeyMaker and HeaderStabilizer with
// multiple HTTP request libraries interchangeably e.g. we could use them with fetch and MSW, too
export interface FauxyRequest<D = any> {
  url: URL;
  method: string;
  headers: Headers;
  data: D;
}

export type AnyJson = boolean | number | string | null | JsonArray | JsonObject;
export interface JsonArray extends Array<AnyJson> {}
export interface JsonObject {
  [key: string]: AnyJson;
}

export type KeyMaker =
  | ((config: FauxyRequest) => JsonObject | null)
  | ((config: FauxyRequest) => Promise<JsonObject | null>);

export type HeaderStabilizer = (headers: Headers) => void;

export interface FauxyProxy {
  keyMaker: KeyMaker;
  libraryDir: string;
  headerStabilizers?: HeaderStabilizer[];
}

export interface FauxyConfig {
  proxies: FauxyProxy[];
  headerStabilizers?: HeaderStabilizer[];
}
