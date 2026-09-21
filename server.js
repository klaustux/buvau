import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir, stat as statFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gzip = promisify(gzipCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WWW_DIR = path.join(__dirname, "www");
const DATA_DIR = path.join(__dirname, "data");
const VISITS_FILE = path.join(DATA_DIR, "visits.json");
const PORT = 8080;
const TOKEN = process.env.BUVAU_TOKEN;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Kelių naudotojų palaikymas per subdomenus: buvau.eimantas.lt — savininkas (esamas
// visits.json/BUVAU_TOKEN, be pakeitimų), buvau-{vardas}.eimantas.lt — atskiras naudotojas,
// jo tokenas aprašytas BUVAU_USERS env kintamajame (JSON, pvz. {"nazg":"<tokenas>"}).
// VIENO LYGIO poddomenas (ne nazg.buvau.eimantas.lt) sąmoningai — Cloudflare nemokamas
// Universal SSL sertifikatas (*.eimantas.lt) dengia tik vieną poddomenų lygį; du lygiai
// (nazg.buvau.eimantas.lt) TLS handshake atmestų (patikrinta, žr. spec.md).
const OWNER_HOST = "buvau.eimantas.lt";
const USER_HOST_PREFIX = "buvau-";
const USER_HOST_SUFFIX = ".eimantas.lt";
let EXTRA_USERS = {};
try {
  EXTRA_USERS = JSON.parse(process.env.BUVAU_USERS || "{}");
} catch {
  console.error("BUVAU_USERS nėra taisyklingas JSON — ignoruojama");
}

function resolveUser(req) {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();

  if (host === OWNER_HOST || host === "localhost" || host === "127.0.0.1") {
    return { key: "", token: TOKEN, dataFile: VISITS_FILE };
  }

  if (host.startsWith(USER_HOST_PREFIX) && host.endsWith(USER_HOST_SUFFIX)) {
    const key = host.slice(USER_HOST_PREFIX.length, -USER_HOST_SUFFIX.length);
    if (Object.prototype.hasOwnProperty.call(EXTRA_USERS, key)) {
      return { key, token: EXTRA_USERS[key], dataFile: path.join(DATA_DIR, `visits-${key}.json`) };
    }
    return null; // subdomenas neatpažintas / nesukonfigūruotas
  }

  // Nežinomas host (lokalus testavimas per IP be Host antraštės ir pan.) — laikom savininku,
  // kad neišardytume esamo naudojimo per smekla.local ir panašiai.
  return { key: "", token: TOKEN, dataFile: VISITS_FILE };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".properties": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateVisits(obj) {
  if (typeof obj !== "object" || obj === null) return "ne objektas";
  if (!Array.isArray(obj.countries) || !obj.countries.every(c => typeof c === "string")) return "countries turi būti string masyvas";
  if (!Array.isArray(obj.cities)) return "cities turi būti masyvas";
  for (const c of obj.cities) {
    if (typeof c !== "object" || c === null) return "kiekvienas cities įrašas turi būti objektas";
    if (typeof c.geonameId !== "number") return "cities[].geonameId turi būti skaičius";
    if (typeof c.name !== "string") return "cities[].name turi būti string";
    if (typeof c.country !== "string") return "cities[].country turi būti string";
    if (typeof c.lat !== "number" || typeof c.lon !== "number") return "cities[].lat/lon turi būti skaičiai";
  }
  return null;
}

const EMPTY_VISITS = { countries: [], cities: [], updatedAt: null };

async function handleGetVisits(req, res) {
  const user = resolveUser(req);
  if (!user) return sendJson(res, 404, { error: "nežinomas naudotojas" });

  try {
    const raw = await readFile(user.dataFile, "utf-8");
    sendJson(res, 200, JSON.parse(raw));
  } catch {
    // Papildomo naudotojo (ne savininko) failas dar neegzistuoja — pirmas kartas, tuščias state'as.
    // Savininko visits.json visada turi egzistuoti — jei jo nėra, tai tikra klaida, ne "naujas naudotojas".
    if (user.key === "") throw new Error("trūksta " + VISITS_FILE);
    sendJson(res, 200, EMPTY_VISITS);
  }
}

async function handlePutVisits(req, res) {
  const user = resolveUser(req);
  if (!user) return sendJson(res, 404, { error: "nežinomas naudotojas" });

  const auth = req.headers["authorization"] || "";
  if (!user.token || auth !== `Bearer ${user.token}`) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 413, { error: "per didelis body" });
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return sendJson(res, 400, { error: "netaisyklingas JSON" });
  }

  const err = validateVisits(parsed);
  if (err) return sendJson(res, 400, { error: err });

  parsed.updatedAt = new Date().toISOString();

  await mkdir(DATA_DIR, { recursive: true });
  const tmpFile = user.dataFile + ".tmp";
  await writeFile(tmpFile, JSON.stringify(parsed, null, 2));
  await rename(tmpFile, user.dataFile);

  sendJson(res, 200, parsed);
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded === "/" ? "/index.html" : decoded;
  const resolved = path.normalize(path.join(WWW_DIR, rel));
  if (!resolved.startsWith(WWW_DIR)) return null;
  return resolved;
}

async function serveFile(req, res, filePath, stat) {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || "application/octet-stream";
  const acceptsGzip = (req.headers["accept-encoding"] || "").includes("gzip");
  const cacheControl = filePath.endsWith("cities-search.json") || filePath.endsWith(".geojson") || filePath.endsWith("d3.min.js")
    ? "public, max-age=86400, must-revalidate"
    : "no-cache";

  // Failo pakeitimo laikas kaip validatorius — be jo max-age=86400 reikštų, kad naršyklė
  // ištisą parą nė nepaklaustų serverio, net jei turinys jau pasikeitė (kaip nutiko su
  // cities-search.json po Heraklion pataisymo).
  const lastModified = stat.mtime.toUTCString();
  const ifModifiedSince = req.headers["if-modified-since"];
  if (ifModifiedSince && new Date(ifModifiedSince).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000) {
    return send(res, 304, null, { "Cache-Control": cacheControl, "Last-Modified": lastModified });
  }

  if (acceptsGzip && stat.size > 1024) {
    const raw = await readFile(filePath);
    const compressed = await gzip(raw);
    return send(res, 200, compressed, {
      "Content-Type": contentType,
      "Content-Encoding": "gzip",
      "Cache-Control": cacheControl,
      "Last-Modified": lastModified,
    });
  }

  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl, "Last-Modified": lastModified });
  createReadStream(filePath).pipe(res);
}

async function handleStatic(req, res) {
  const filePath = safeStaticPath(req.url);
  if (!filePath) return send(res, 403, "Forbidden");

  let stat;
  try {
    stat = await statFile(filePath);
  } catch {
    // Kliento pusės maršrutai (pvz. /salis/LT, /zemynai) neturi realaus failo serveryje —
    // jei kelio paskutinis segmentas be plėtinio (ne tikras asset'as), atiduodam index.html,
    // kad veiktų atnaujinimas/tiesioginė nuoroda į tokį URL (SPA "history fallback").
    const lastSegment = req.url.split("?")[0].split("/").pop();
    if (!lastSegment || !lastSegment.includes(".")) {
      try {
        const indexPath = path.join(WWW_DIR, "index.html");
        const indexStat = await statFile(indexPath);
        return await serveFile(req, res, indexPath, indexStat);
      } catch {
        // kris toliau į 404
      }
    }
    return send(res, 404, "Not found");
  }
  if (!stat.isFile()) return send(res, 404, "Not found");

  return await serveFile(req, res, filePath, stat);
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/visits")) {
      if (req.method === "GET") return await handleGetVisits(req, res);
      if (req.method === "PUT") return await handlePutVisits(req, res);
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (req.method === "GET") return await handleStatic(req, res);
    return send(res, 405, "Method not allowed");
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => console.log(`buvau server listening on :${PORT}`));
