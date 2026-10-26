// Tiny static server for the sample app: node serve.ts <folder> <port>.
// /login and /home serve their folder's index.html.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const [root = ".", port = "4173"] = process.argv.slice(2);
const base = path.resolve(root);
createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  let file = path.resolve(base, `.${url.pathname}`);
  if (existsSync(file) && statSync(file).isDirectory())
    file = path.join(file, "index.html");
  if (!file.startsWith(base) || !existsSync(file)) {
    response.writeHead(302, { location: "/login/" }).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(readFileSync(file));
}).listen(Number(port));
