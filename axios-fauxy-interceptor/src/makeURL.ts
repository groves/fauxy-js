import axios, { AxiosRequestConfig } from "axios";

export function makeURL(config: AxiosRequestConfig): URL {
  const uri = axios.getUri(config);
  return new URL(uri, "http://localhost");
}
