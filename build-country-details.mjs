import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const d3 = require("./www/d3.min.js");

let world = JSON.parse(readFileSync(new URL("./world-10m.geojson", import.meta.url), "utf-8"));

function rawIso(f) {
  const p = f.properties;
  return p.ISO_A2_EH !== "-99" ? p.ISO_A2_EH : p.ISO_A2;
}

// Krymas Natural Earth duomenyse yra Rusijos MultiPolygon dalis (ne atskiras "feature") —
// naudotojo sprendimu žymimas kaip Ukraina. Tas pats principas kaip www/index.html
// splitCrimeaFromRussia — atskiriama pagal koordinačių rėžį (fiziškai nesujungta su
// žemynine Rusija vektoriniuose duomenyse).
function splitCrimeaFromRussia(features) {
  const idx = features.findIndex(f => f.properties.NAME === "Russia");
  if (idx === -1) return features;
  const russia = features[idx];
  const BBOX = { lonMin: 32, lonMax: 37, latMin: 44, latMax: 46.5 };
  const crimeaRings = [], restRings = [];
  for (const ring of russia.geometry.coordinates) {
    const poly = { type: "Feature", geometry: { type: "Polygon", coordinates: ring } };
    const [[lon0, lat0], [lon1, lat1]] = d3.geoBounds(poly);
    const inCrimea = lon0 >= BBOX.lonMin && lon1 <= BBOX.lonMax && lat0 >= BBOX.latMin && lat1 <= BBOX.latMax;
    (inCrimea ? crimeaRings : restRings).push(ring);
  }
  if (!crimeaRings.length) return features;
  const result = [...features];
  result[idx] = { ...russia, geometry: { ...russia.geometry, coordinates: restRings } };
  result.push({
    type: "Feature",
    properties: { ...russia.properties, NAME: "Crimea", ADMIN: "Crimea" },
    geometry: { type: "MultiPolygon", coordinates: crimeaRings },
  });
  return result;
}
world.features = splitCrimeaFromRussia(world.features);

const anchorIso = new Map();
for (const f of world.features) {
  if (f.properties.ADMIN === f.properties.SOVEREIGNT) anchorIso.set(f.properties.SOV_A3, rawIso(f));
}
// Farerų salos NĖRA traktuojamos kaip Danijos dalis (naudotojo pasirinkimas) — savo šalis,
// kurią bus galima pažymėti atskirai, jei/kai ten apsilankys. Krymas — kaip Ukraina.
const SOVEREIGNTY_EXCEPTIONS = new Set(["Faeroe Is."]);
const ISO_OVERRIDE = { "Crimea": "UA" };
const effectiveIso = f =>
  ISO_OVERRIDE[f.properties.NAME] ??
  (SOVEREIGNTY_EXCEPTIONS.has(f.properties.NAME) ? rawIso(f) : anchorIso.get(f.properties.SOV_A3) ?? rawIso(f));

// Tas pats algoritmas kaip www/index.html clusterNearMainland/trimSelf — čia paleidžiamas
// VIENĄ KARTĄ build metu (10m duomenys per dideli/detalūs skaičiuoti kliento naršyklėje).
// Du žingsniai: (1) feature apsivalo pats savyje (Prancūzijos Gviana atkrenta iš vidaus);
// (2) grupėje paliekami tik netoli NAMŲ šalies (ADMIN===SOVEREIGNT) esantys features —
// Grenlandija (didesnė plotu už Daniją, bet toli) atkrenta visa, Farerai (arti) lieka.
function trimSelf(feature, thresholdDeg = 15) {
  if (feature.geometry.type !== "MultiPolygon") return feature;
  const rings = feature.geometry.coordinates;
  const ringFeatures = rings.map(coords => ({ type: "Feature", geometry: { type: "Polygon", coordinates: coords } }));
  const areas = ringFeatures.map(rf => Math.abs(d3.geoArea(rf)));
  const mainCentroid = d3.geoCentroid(ringFeatures[areas.indexOf(Math.max(...areas))]);
  const thresholdRad = (thresholdDeg * Math.PI) / 180;
  const kept = rings.filter((_, i) => d3.geoDistance(d3.geoCentroid(ringFeatures[i]), mainCentroid) < thresholdRad);
  if (kept.length === rings.length) return feature;
  return { ...feature, geometry: { type: "MultiPolygon", coordinates: kept } };
}

function featureMainCentroid(feature) {
  if (feature.geometry.type !== "MultiPolygon") return d3.geoCentroid(feature);
  const rings = feature.geometry.coordinates;
  const ringFeatures = rings.map(coords => ({ type: "Feature", geometry: { type: "Polygon", coordinates: coords } }));
  const areas = ringFeatures.map(rf => Math.abs(d3.geoArea(rf)));
  return d3.geoCentroid(ringFeatures[areas.indexOf(Math.max(...areas))]);
}

function clusterNearMainland(features, thresholdDeg = 14) {
  const trimmed = features.map(f => trimSelf(f));
  const home = trimmed.find(f => f.properties.ADMIN === f.properties.SOVEREIGNT) ?? trimmed[0];
  const homeCentroid = featureMainCentroid(home);
  const thresholdRad = (thresholdDeg * Math.PI) / 180;
  return trimmed.filter(f => d3.geoDistance(featureMainCentroid(f), homeCentroid) < thresholdRad);
}

// Douglas-Peucker supaprastinimas — 10m duomenys turi žymiai daugiau taškų, nei reikia
// mažam (~300x260px) šalies miniatiūros žemėlapiui; be to jaučiasi "triukšmingai" (smulkūs
// fiordų/salų vingiai). toleranceDeg apytiksliai laipsniais (0.02° ≈ ~2km prie pusiaujo).
function perpendicularDist(p, a, b) {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / len2;
  const px = x1 + t * dx, py = y1 + t * dy;
  return Math.hypot(x - px, y - py);
}

function simplifyRing(points, toleranceDeg) {
  if (points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = -1, maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDist(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > toleranceDeg) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  const result = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) result.push(points[i]);
  return result.length >= 4 ? result : points;
}

function simplifyFeature(feature, toleranceDeg = 0.02) {
  const geom = feature.geometry;
  const coordinates =
    geom.type === "Polygon"
      ? geom.coordinates.map(ring => simplifyRing(ring, toleranceDeg))
      : geom.coordinates.map(poly => poly.map(ring => simplifyRing(ring, toleranceDeg)));
  return { ...feature, geometry: { ...geom, coordinates } };
}

const byIso = new Map();
for (const f of world.features) {
  const iso = effectiveIso(f);
  if (!byIso.has(iso)) byIso.set(iso, []);
  byIso.get(iso).push(f);
}

mkdirSync(new URL("./www/countries-10m/", import.meta.url), { recursive: true });

let count = 0;
for (const [iso, group] of byIso) {
  const cleaned = clusterNearMainland(group).map(f => simplifyFeature({
    type: "Feature",
    properties: {},
    geometry: f.geometry,
  }));
  writeFileSync(
    new URL(`./www/countries-10m/${iso}.json`, import.meta.url),
    JSON.stringify({ type: "FeatureCollection", features: cleaned })
  );
  count++;
}

console.log(`Sugeneruota ${count} šalių 10m failų į www/countries-10m/`);
