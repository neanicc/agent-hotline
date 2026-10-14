// Test helper: raw HTTP to 127.0.0.1, so tests can set any Host header.
import { request } from "node:http";

export interface SendOptions {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function send({ port, path, method = "GET", headers = {}, body }: SendOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { connection: "close", ...headers }, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
