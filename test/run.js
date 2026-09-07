// SPDX-FileCopyrightText: 2026 Jakub Majcher
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Runs content.js against test/fixture.html inside jsdom and checks the result.
 *
 *   npm install && npm test
 *
 * content.js is one big IIFE whose value is the result the popup receives, so evaluating
 * the file in a context with a jsdom `document` is enough - no build step, no exports.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const PAGE_URL = "https://example.com/kursy/index.html";

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.error("jsdom is missing - run `npm install` first.");
  process.exit(2);
}

const EXPECTED = [
  {
    what: "title attribute on <video src>",
    url: "https://example.com/kursy/videos/intro.mp4",
    title: "Wprowadzenie do kursu",
    extension: "mp4",
    isStream: false,
  },
  {
    what: "a Cyrillic title is kept instead of being folded away",
    url: "https://example.com/kursy/clips/nocnaya.mp4",
    title: "Ночная погоня",
    extension: "mp4",
    isStream: false,
  },
  {
    what: "<source> titled by the heading above the player",
    url: "https://example.com/media/lecture-02.webm",
    title: "Wykład 2 — sieci neuronowe",
    extension: "webm",
    isStream: false,
  },
  {
    what: '"Download" rejected, name taken from the table row',
    url: "http://cdn.example.com/big_buck_bunny_1080p.mp4",
    title: "Wielki film przyrodniczy",
    extension: "mp4",
    isStream: false,
    resolution: "1080p",
    resolutionSource: "address",
  },
  {
    what: 'a row of nothing but "5" and "1920 x 1080" is not a title either',
    url: "https://example.com/vids/Big_Buck_Bunny_1080_10s_5MB.mp4",
    title: "Big Buck Bunny 1080 10s 5MB",
    extension: "mp4",
    isStream: false,
    // The same row text that is rejected as a title is where the resolution comes from.
    resolution: "1080p",
    resolutionSource: "page",
  },
  {
    what: '"Pobierz" with no context falls back to the file name, not the page <h1>',
    url: "https://example.com/kursy/clips/raw_footage.final.ogg",
    title: "Raw footage final",
    extension: "ogg",
    isStream: false,
  },
  {
    what: "resolution read out of the file name",
    url: "https://example.com/kursy/clips/wywiad_1080p.mp4",
    title: "Wywiad 1080p",
    extension: "mp4",
    isStream: false,
    resolution: "1080p",
    resolutionSource: "address",
  },
  {
    what: "a resolution printed next to the link beats the one in the address",
    url: "https://example.com/vids/720/premiera.mp4",
    title: "Premiera",
    extension: "mp4",
    isStream: false,
    resolution: "1080p",
    resolutionSource: "page",
  },
  {
    what: '"Ściągnij" folds to "sciagnij" and is rejected like any other generic label',
    url: "https://example.com/kursy/clips/wywiad_koncowy.webm",
    title: "Wywiad koncowy",
    extension: "webm",
    isStream: false,
  },
  {
    what: "alt of the nested image; ?query and #hash survive",
    url: "https://x.example/movie.mp4?token=abc#t=10",
    title: "Nocny pościg",
    extension: "mp4",
    isStream: false,
  },
  {
    what: "URL reachable only from an inline script, titled by og:title",
    url: "https://example.com/fallback/backup_take.mp4",
    title: "Kursy wideo Example",
    extension: "mp4",
    isStream: false,
  },
  {
    what: "cda.pl-style manifest from an attribute, streams sorted last",
    url: "https://vod99.example.com/abc/stream.mpd",
    title: "Kursy wideo Example",
    extension: "mpd",
    isStream: true,
  },
];

const REJECTED = ["blob:", "javascript:", "dokumentacja.html"];

const findVideos = () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8"), {
    url: PAGE_URL,
  });
  // A bare vm context has no URL constructor - content.js needs the page's own.
  const context = vm.createContext({ document: dom.window.document, URL: dom.window.URL });
  return vm.runInContext(fs.readFileSync(path.join(ROOT, "content.js"), "utf8"), context, {
    filename: "content.js",
  });
};

const failures = [];
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
};

const results = findVideos();

check("result count (duplicate URL must collapse into one)", results.length, EXPECTED.length);

EXPECTED.forEach((expected, index) => {
  const actual = results[index];
  if (!actual) {
    failures.push(`#${index + 1} ${expected.what}\n      missing entirely`);
    return;
  }
  const keys = ["url", "title", "extension", "isStream"];
  for (const optional of ["resolution", "resolutionSource"]) {
    if (optional in expected) keys.push(optional);
  }
  for (const key of keys) {
    check(`#${index + 1} ${expected.what} -> ${key}`, actual[key], expected[key]);
  }
});

for (const rejected of REJECTED) {
  const leaked = results.find((result) => result.url.includes(rejected));
  if (leaked) failures.push(`${rejected} must be ignored, got: ${leaked.url}`);
}

for (const result of results) {
  const label = `${result.isStream ? "stream" : "file  "} ${result.extension.padEnd(4)}`;
  const res = result.resolution ? `${result.resolution} (${result.resolutionSource})` : "-";
  console.log(`  ${label} ${res.padEnd(14)} ${result.title}`);
}

// A key that exists in the code but not in _locales renders as empty text in the popup,
// which no amount of clicking around makes obvious. Check it here instead.
const locale = (code) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", code, "messages.json"), "utf8"));

const en = locale("en");
const pl = locale("pl");
const source = ["popup.js", "popup.html", "manifest.json"]
  .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
  .join("\n");

const usedKeys = new Set([
  ...[...source.matchAll(/\bt\("([A-Za-z0-9_]+)"/g)].map(([, key]) => key),
  ...[...source.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)].map(([, key]) => key),
  ...[...source.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map(([, key]) => key),
]);

for (const key of usedKeys) {
  for (const [code, messages] of [["en", en], ["pl", pl]]) {
    if (!messages[key]) failures.push(`message "${key}" used in the popup is missing from _locales/${code}`);
  }
}
for (const key of Object.keys(en)) {
  if (!pl[key]) failures.push(`message "${key}" is in _locales/en but not in _locales/pl`);
}
for (const key of Object.keys(pl)) {
  if (!en[key]) failures.push(`message "${key}" is in _locales/pl but not in _locales/en`);
}
for (const key of Object.keys(en)) {
  if (!usedKeys.has(key)) failures.push(`message "${key}" is defined but nothing uses it`);
}

console.log(`\n  i18n: ${usedKeys.size} keys in use, ${Object.keys(en).length} defined per locale`);

// AMO refuses a version number it has seen before, so a manifest and package.json that
// drift apart turn into a rejected upload at the worst possible moment.
const versionOf = (file) => {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  return (raw.match(/"version"\s*:\s*"([^"]+)"/) ?? [])[1];
};

const manifestVersion = versionOf("manifest.json");
const packageVersion = versionOf("package.json");

check("manifest.json vs package.json version", packageVersion, manifestVersion);
if (!/^\d+\.\d+\.\d+$/.test(manifestVersion ?? "")) {
  failures.push(`manifest version "${manifestVersion}" is not a plain x.y.z number`);
}

/**
 * Patterns that move an AMO submission from automated signing into the manual review
 * queue, and are the usual reason for a rejection. None of them are needed here, so the
 * cheapest way to keep it that way is to fail the build when one shows up.
 */
const FORBIDDEN = [
  [/\beval\s*\(/, "eval()"],
  [/new\s+Function\s*\(/, "new Function()"],
  [/\.innerHTML\s*=/, "innerHTML assignment"],
  [/\.outerHTML\s*=/, "outerHTML assignment"],
  [/insertAdjacentHTML/, "insertAdjacentHTML()"],
  [/document\.write\s*\(/, "document.write()"],
  [/<script[^>]+src\s*=\s*["']https?:/i, "remote script tag"],
  [/setTimeout\s*\(\s*["'`]/, "setTimeout with a string body"],
];

const SHIPPED_FILES = ["content.js", "popup.js", "popup.html"];

for (const file of SHIPPED_FILES) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const [pattern, label] of FORBIDDEN) {
    if (pattern.test(source)) failures.push(`${file} uses ${label}, which invites a manual AMO review`);
  }
}

console.log(`  package: version ${manifestVersion}, ${SHIPPED_FILES.length} shipped files clean of ${FORBIDDEN.length} review-triggering patterns`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\nOK - ${results.length} entries, all checks passed.`);
