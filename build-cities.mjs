import { readFileSync, writeFileSync } from "node:fs";

const raw = readFileSync(new URL("./cities1000.txt", import.meta.url), "utf-8");
const cities = [];

// Tik lotyniško rašto alternatyvos (kad "Heraklion" atrastų GeoNames pagrindinį vardą
// "Irákleion", "Zurich" -> "Zürich" ir pan.) — tik reikšmingesniems miestams (>15000 gyv.),
// kad nesipūstų failo dydis smulkiems vardams, kuriems tokių angliškų atitikmenų retai reikia.
const LATIN_RE = /^[\x00-\x7fÀ-ÿ\s',.\-]+$/;
const ALT_NAME_POPULATION_THRESHOLD = 15000;

// Kompaktus [geonameId, name, country, lat, lon, altNames?] masyvas vietoj objektų su
// pavadintais laukais — ~2x mažesnis gzip'as (raktų pavadinimai nesikartoja 171k kartų).
// lat/lon suapvalinta iki 3 skaičių po kablelio (~110m tikslumas) — pakanka paieškai.
// altNames (6-as elementas) pridedamas TIK kai yra ką pridėti — taupo vietą daugumai įrašų.
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  const cols = line.split("\t");
  const population = Number(cols[14]) || 0;
  const row = [
    Number(cols[0]),
    cols[1],
    cols[8],
    Math.round(Number(cols[4]) * 1000) / 1000,
    Math.round(Number(cols[5]) * 1000) / 1000,
  ];
  if (population > ALT_NAME_POPULATION_THRESHOLD && cols[3]) {
    const altNames = [...new Set(cols[3].split(",").filter(a => a && a !== cols[1] && LATIN_RE.test(a)))];
    if (altNames.length) row.push(altNames.join("|"));
  }
  cities.push(row);
}

writeFileSync(new URL("./www/cities-search.json", import.meta.url), JSON.stringify(cities));
console.log(`Išsaugota ${cities.length} miestų į www/cities-search.json`);
