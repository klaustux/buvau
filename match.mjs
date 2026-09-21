import { readFileSync, writeFileSync } from "node:fs";

function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// index: countryCode -> normalizedName -> [ {geonameId, name, lat, lon} ]
const index = new Map();

const raw = readFileSync(new URL("./cities1000.txt", import.meta.url), "utf-8");
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  const cols = line.split("\t");
  const geonameId = Number(cols[0]);
  const name = cols[1];
  const asciiname = cols[2];
  const alternatenames = cols[3];
  const lat = Number(cols[4]);
  const lon = Number(cols[5]);
  const country = cols[8];

  const names = new Set([name, asciiname]);
  if (alternatenames) {
    for (const alt of alternatenames.split(",")) {
      // tik lotyniško rašto alternatyvos, be diakritikos triukšmo tikslumui nesvarbu (normalize() vis tiek nuima)
      if (/^[\x00-\x7FÀ-ſ\s'.-]+$/.test(alt)) names.add(alt);
    }
  }

  if (!index.has(country)) index.set(country, new Map());
  const byName = index.get(country);
  for (const n of names) {
    const key = normalize(n);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ geonameId, name, lat, lon });
  }
}

const input = JSON.parse(
  readFileSync(new URL("./visits.import.json", import.meta.url), "utf-8")
);

const matched = [];
const unmatched = [];
const fuzzy = [];

for (const city of input.cities) {
  const byName = index.get(city.country);
  const key = normalize(city.name);
  const candidates = byName?.get(key) ?? [];

  if (candidates.length === 0) {
    unmatched.push(city);
    continue;
  }

  let best = candidates[0];
  let bestDist = haversineKm(city.lat, city.lon, best.lat, best.lon);
  for (const c of candidates.slice(1)) {
    const d = haversineKm(city.lat, city.lon, c.lat, c.lon);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }

  if (bestDist > 25) {
    // pavadinimas sutapo, bet artimiausias kandidatas nutolęs >25km — tikriausiai netikras
    // atitikmuo (dažnai vietovė, kuri GeoNames "cities" faile apskritai neegzistuoja,
    // pvz. kalnas/vienuolynas), tad NEpriimam automatiškai — reikia rankinio sprendimo
    fuzzy.push({ ...city, matchedName: best.name, matchedGeonameId: best.geonameId, distanceKm: Math.round(bestDist) });
    continue;
  }

  matched.push({
    geonameId: best.geonameId,
    name: city.name,
    country: city.country,
    lat: city.lat,
    lon: city.lon,
  });
}

const result = {
  countries: input.countries,
  cities: matched,
  updatedAt: null,
};

writeFileSync(
  new URL("./visits.json", import.meta.url),
  JSON.stringify(result, null, 2)
);

console.log(`Sumatchinta: ${matched.length} / ${input.cities.length}`);
console.log(`Nerasta pagal pavadinimą+šalį: ${unmatched.length}`);
if (unmatched.length) {
  for (const c of unmatched) console.log(`  ? ${c.name}, ${c.country} (${c.lat}, ${c.lon})`);
}
console.log(`Įtartini matchai (>25km nuo koordinatės): ${fuzzy.length}`);
if (fuzzy.length) {
  for (const c of fuzzy)
    console.log(`  ! ${c.name} -> ${c.matchedName} (${c.country}), ${c.distanceKm}km, geonameId=${c.geonameId}`);
}
