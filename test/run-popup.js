// SPDX-FileCopyrightText: 2026 Jakub Majcher
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Renders popup.html with popup.js in jsdom against a stubbed extension API and checks
 * what the user would actually see.
 *
 * This exists because a popup that renders empty buttons throws no error anywhere: a
 * missing message is an empty string, and an empty string is a perfectly valid label.
 * The browser API stub resolves messages from _locales the way Firefox does, so a broken
 * key or a broken call shows up here instead of in a screenshot.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.error("jsdom is missing - run `npm install` first.");
  process.exit(2);
}

const messages = JSON.parse(
  fs.readFileSync(path.join(ROOT, "_locales", "en", "messages.json"), "utf8"),
);

/** Mirrors i18n.getMessage: named placeholders resolve to $1..$9 substitutions. */
const getMessage = (key, substitutions) => {
  const entry = messages[key];
  if (!entry) return "";

  const list = [].concat(substitutions ?? []);
  return entry.message.replace(/\$([a-zA-Z0-9_]+)\$/g, (whole, name) => {
    const placeholder = entry.placeholders?.[name];
    if (!placeholder) return whole;
    const index = Number(String(placeholder.content).replace("$", "")) - 1;
    return list[index] ?? "";
  });
};

const VIDEOS = [
  {
    url: "https://example.com/clips/lecture-02.mp4",
    title: "Lecture 2",
    fileName: "lecture-02.mp4",
    extension: "mp4",
    isStream: false,
    resolution: "720p",
    resolutionSource: "player",
  },
  {
    url: "https://vod.example.com/abc/stream.mpd",
    title: "Charity stream",
    fileName: "stream.mpd",
    extension: "mpd",
    isStream: true,
  },
  // Same title and file name from three codec directories, as test-videos.co.uk serves
  // them. The rows must not read as duplicates.
  {
    url: "https://example.com/vids/mp4/av1/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    title: "Big Buck Bunny 360 10s 1MB",
    fileName: "Big_Buck_Bunny_360_10s_1MB.mp4",
    extension: "mp4",
    isStream: false,
    resolution: "360p",
    resolutionSource: "address",
  },
  {
    url: "https://example.com/vids/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    title: "Big Buck Bunny 360 10s 1MB",
    fileName: "Big_Buck_Bunny_360_10s_1MB.mp4",
    extension: "mp4",
    isStream: false,
  },
  {
    url: "https://example.com/vids/webm/vp9/360/Big_Buck_Bunny_360_10s_1MB.webm",
    title: "Big Buck Bunny 360 10s 1MB",
    fileName: "Big_Buck_Bunny_360_10s_1MB.mp4",
    extension: "webm",
    isStream: false,
  },
  // Signed CDN links: same path, different token. Nothing in the path can separate them.
  {
    url: "https://cdn.example.com/v/clip.mp4?token=AAA&e=1",
    title: "Clip",
    fileName: "clip.mp4",
    extension: "mp4",
    isStream: false,
  },
  {
    url: "https://cdn.example.com/v/clip.mp4?token=BBB&e=2",
    title: "Clip",
    fileName: "clip.mp4",
    extension: "mp4",
    isStream: false,
  },
];

const failures = [];
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}\n      expected: ${expected}\n      actual:   ${actual}`);
};
const checkNotEmpty = (label, actual) => {
  if (!actual || !String(actual).trim()) failures.push(`${label}\n      got an empty string`);
};

const render = async () => {
  const copied = [];

  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "popup.html"), "utf8"), {
    runScripts: "dangerously",
    resources: undefined,
    url: "moz-extension://test/popup.html",
    beforeParse(window) {
      window.browser = {
        i18n: { getMessage, getUILanguage: () => "en" },
        tabs: {
          query: async () => [{ id: 1, url: "https://example.com/" }],
          create: () => {},
        },
        scripting: { executeScript: async () => [{ result: VIDEOS }] },
      };
      window.navigator.clipboard = {
        writeText: async (text) => {
          copied.push(text);
        },
      };
    },
  });

  // popup.js runs by hand, after parsing: jsdom does not fetch the relative script URL,
  // and beforeParse is too early - there is no documentElement yet.
  dom.window.eval(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"));

  const { document } = dom.window;
  for (let waited = 0; waited < 50 && !document.querySelectorAll(".result").length; waited++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { dom, document, copied };
};

const main = async () => {
  const { dom, document, copied } = await render();

  const rows = [...document.querySelectorAll(".result")];
  check("rendered row count", rows.length, VIDEOS.length);

  checkNotEmpty("header title (data-i18n)", document.querySelector(".header__title")?.textContent);
  check(
    "header title text",
    document.querySelector(".header__title")?.textContent,
    messages.extensionName.message,
  );
  checkNotEmpty("result counter", document.getElementById("count")?.textContent);
  check(
    "counter shows the number",
    document.getElementById("count").textContent.includes(String(VIDEOS.length)),
    true,
  );
  check("document language", document.documentElement.lang, "en");

  rows.forEach((row, index) => {
    const video = VIDEOS[index];
    const label = `row ${index + 1} (${video.extension})`;

    checkNotEmpty(`${label} title text`, row.querySelector(".result__title")?.textContent);
    checkNotEmpty(`${label} file name`, row.querySelector(".result__file")?.textContent);

    const buttons = [...row.querySelectorAll(".copy-button")];
    check(`${label} button count`, buttons.length, video.isStream ? 2 : 1);
    buttons.forEach((button, position) => {
      // Icon-only buttons: aria-label and the tooltip are the whole accessible name.
      checkNotEmpty(`${label} button ${position + 1} aria-label`, button.getAttribute("aria-label"));
      checkNotEmpty(`${label} button ${position + 1} tooltip`, button.title);
      check(`${label} button ${position + 1} has an icon`, !!button.querySelector("svg"), true);
    });
    check(`${label} first button label`, buttons[0]?.getAttribute("aria-label"), messages.copyLink.message);

    const title = row.querySelector(".result__title");
    if (video.isStream) {
      // A manifest opened in a tab downloads XML, so it must not be a link.
      check(`${label} title is not a link`, title?.tagName, "SPAN");
      check(
        `${label} command button label`,
        buttons[1]?.getAttribute("aria-label"),
        messages.copyCommand.message,
      );
    } else {
      check(`${label} title is a link`, title?.tagName, "A");
      check(`${label} link target`, title?.getAttribute("href"), video.url);
    }
  });

  checkNotEmpty("stream hint", document.getElementById("hint")?.textContent);

  // Rows 3-5 share a title and a file name; the codec badge has to separate them.
  const collidingBadges = rows.slice(2, 5).map((row) => row.querySelector(".badge").textContent);
  check("colliding rows are told apart", new Set(collidingBadges).size, collidingBadges.length);
  check("codec badges", collidingBadges.join(" "), "MP4·AV1·360p MP4·H264 WEBM·VP9");

  // The badge carries the container, so the file name must not repeat the extension.
  for (const [index, row] of rows.entries()) {
    const shown = row.querySelector(".result__file").textContent;
    if (/\.(mp4|webm|ogg|mpd|m3u8)$/i.test(shown)) {
      failures.push(`row ${index + 1} repeats the extension already shown in the badge\n      got: ${shown}`);
    }
  }
  check("resolution joins the badge", rows[0].querySelector(".badge").textContent, "MP4·720p");
  check(
    "badge tooltip names the source",
    rows[0].querySelector(".badge").title,
    messages.resolutionFromPlayer.message.replace("$value$", "720p"),
  );
  check("codec and resolution together", rows[2].querySelector(".badge").textContent, "MP4·AV1·360p");
  check("row without resolution keeps a bare badge", rows[3].querySelector(".badge").textContent, "MP4·H264");

  // Rows 6-7 differ only past the "?"; the query has to reach the screen.
  const signed = rows.slice(5).map((row) => row.querySelector(".result__file").textContent);
  check("signed links are told apart", new Set(signed).size, signed.length);
  for (const [index, token] of [[0, "token=AAA"], [1, "token=BBB"]]) {
    if (!signed[index]?.includes(token)) {
      failures.push(`signed row ${index + 1} should show ${token}\n      got: ${signed[index]}`);
    }
  }

  // Clicking must copy the URL and confirm it on the button.
  const firstButton = rows[0].querySelector(".copy-button");
  firstButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("copied text", copied[0], VIDEOS[0].url);
  check("button confirms the copy", firstButton.getAttribute("aria-label"), messages.copied.message);
  check("confirmation is marked", firstButton.classList.contains("copy-button--copied"), true);

  console.log(`  popup: ${rows.length} rows rendered, every label non-empty, copy confirmed`);

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nOK - popup renders with all labels in place.");
};

main().catch((error) => {
  console.error("popup test crashed:", error);
  process.exit(1);
});
