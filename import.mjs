import { readFileSync, writeFileSync } from "node:fs";

// CSV naudoja pilnus angliškus šalių pavadinimus (Been/TripAdvisor eksporto formatas),
// kurie nebūtinai sutampa su i18n/countries_en.properties rodomais pavadinimais
// (pvz. "UK" vs "United Kingdom", "Turkiye" vs "Türkiye") — todėl atskiras mapping.
const CSV_COUNTRY_TO_ISO = {
  "Austria": "AT",
  "Belarus": "BY",
  "Belgium": "BE",
  "Croatia": "HR",
  "Czech Republic": "CZ",
  "Denmark": "DK",
  "Estonia": "EE",
  "Finland": "FI",
  "France": "FR",
  "Georgia": "GE",
  "Germany": "DE",
  "Greece": "GR",
  "Hungary": "HU",
  "Iceland": "IS",
  "India": "IN",
  "Ireland": "IE",
  "Italy": "IT",
  "Latvia": "LV",
  "Liechtenstein": "LI",
  "Lithuania": "LT",
  "Monaco": "MC",
  "Morocco": "MA",
  "Norway": "NO",
  "Poland": "PL",
  "Portugal": "PT",
  "Romania": "RO",
  "Russia": "RU",
  "Slovakia": "SK",
  "Slovenia": "SI",
  "Spain": "ES",
  "Sweden": "SE",
  "Switzerland": "CH",
  "The Netherlands": "NL",
  "Turkiye": "TR",
  "UK": "GB",
  "USA": "US",
  "Vatican City": "VA",
};

function parseCsvLine(line) {
  return line.split(";").map((field) => field.trim().replace(/^"|"$/g, ""));
}

const raw = readFileSync(new URL("./klaustux.csv", import.meta.url), "utf-8");
const lines = raw.split("\n").filter((l) => l.trim().length > 0);
const [, ...rows] = lines;

const cities = [];
const countriesSet = new Set();
const skippedWant = [];
const unknownCountries = new Set();

for (const line of rows) {
  const [lat, lon, country, city, been] = parseCsvLine(line);
  if (!been.includes("been")) {
    skippedWant.push(`${city}, ${country}`);
    continue;
  }
  const iso = CSV_COUNTRY_TO_ISO[country];
  if (!iso) {
    unknownCountries.add(country);
    continue;
  }
  countriesSet.add(iso);
  cities.push({
    geonameId: null, // TODO: matchinti su cities5000 pagal name+country+artimiausią lat/lon
    name: city,
    country: iso,
    lat: Number(lat),
    lon: Number(lon),
  });
}

const result = {
  countries: [...countriesSet].sort(),
  cities,
  updatedAt: null, // stamp'inama po importo, ne scripte (žr. Workflow apribojimus dėl Date.now())
};

writeFileSync(
  new URL("./visits.import.json", import.meta.url),
  JSON.stringify(result, null, 2)
);

console.log(`Importuota miestų: ${cities.length}`);
console.log(`Unikalių šalių: ${result.countries.length}`);
console.log(`Praleista (want): ${skippedWant.length}`);
if (skippedWant.length) console.log("  ", skippedWant.join("; "));
if (unknownCountries.size) {
  console.log(`NEŽINOMOS šalys (nėra mapping'e, praleista): ${[...unknownCountries].join(", ")}`);
}
