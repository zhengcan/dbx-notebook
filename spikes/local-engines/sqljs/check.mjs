import http from "http"; import fs from "fs"; import path from "path";
import { chromium } from "../../vega-sandbox/ui/node_modules/playwright/index.mjs";
const csps = {
  "A fetch-wasm - wasm-unsafe-eval with connect-src self": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'",
  "B fetch-wasm - neither eval flag with connect-src self": "default-src 'none'; script-src 'self'; connect-src 'self'",
  "C inline-wasm - wasm-unsafe-eval, NO connect-src": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'",
  "D inline-wasm - neither flag, NO connect-src": "default-src 'none'; script-src 'self'",
  "E inline-wasm - unsafe-eval only, NO connect-src": "default-src 'none'; script-src 'self' 'unsafe-eval'",
};
const srv = http.createServer((q, s) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/page.html") { s.setHeader("content-type", "text/html"); return s.end(fs.readFileSync("page.html", "utf8").replace("__CSP__", csps[u.searchParams.get("c")]).replace("__JS__", u.searchParams.get("c").includes("inline") ? "sql-wasm-inline.js" : "sql-wasm.js")); }
  const f = path.join(".", u.pathname);
  if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); }
  s.setHeader("content-type", f.endsWith(".wasm") ? "application/wasm" : f.endsWith(".js") ? "text/javascript" : "text/plain"); s.end(fs.readFileSync(f));
}).listen(0);
const port = srv.address().port;
const b = await chromium.launch({ channel: "chrome" });
for (const c of Object.keys(csps)) {
  const p = await b.newPage(); const logs = [];
  p.on("console", m => logs.push(m.text())); p.on("pageerror", e => logs.push("PAGEERR " + e.message));
  await p.goto(`http://localhost:${port}/page.html?c=${encodeURIComponent(c)}`); await p.waitForTimeout(2500);
  console.log(c, "=>", logs.filter(l => !/favicon/.test(l)).join(" | ").slice(0, 400)); await p.close();
}
await b.close(); srv.close();
