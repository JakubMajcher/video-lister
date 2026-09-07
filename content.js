// SPDX-FileCopyrightText: 2026 Jakub Majcher
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Injected on demand by the popup via scripting.executeScript({ files: ["content.js"] }).
 * The value of the trailing IIFE is what the popup receives as the injection result.
 */
(() => {
  const FILE_EXTENSIONS = ["mp4", "webm", "ogg"];
  const STREAM_EXTENSIONS = ["m3u8", "mpd"];
  const ALL_EXTENSIONS = [...FILE_EXTENSIONS, ...STREAM_EXTENSIONS];

  const EXTENSION_PATTERN = new RegExp(`\\.(${ALL_EXTENSIONS.join("|")})$`, "i");
  const ALLOWED_PROTOCOLS = ["http:", "https:", "file:"];
  const MAX_TITLE_LENGTH = 120;
  const MAX_CONTEXT_LENGTH = 160;
  /** Guard so a multi-megabyte SPA document can't stall the regex sweep. */
  const MAX_MARKUP_LENGTH = 4_000_000;

  /**
   * Link labels that describe the action, not the video. Without this filter every row
   * on a download page ends up titled "Download".
   *
   * These match text on the page, not interface copy, so the list stays multilingual
   * whatever the browser locale is. Add languages as they come up.
   */
  const GENERIC_LABELS = new Set([
    "download", "download video", "download file", "direct link", "direct download", "dl",
    "pobierz", "pobierz plik", "pobierz wideo", "sciagnij", "zapisz", "zapisz jako", "save",
    "save as", "save video", "click here", "click", "kliknij", "kliknij tutaj", "tutaj", "here",
    "link", "links", "url", "video", "wideo", "film", "movie", "clip", "klip", "watch",
    "watch now", "play", "odtworz", "zobacz", "open", "otworz", "source", "sources", "zrodlo",
    "stream", "more", "wiecej", "read more", "czytaj wiecej", "mirror", "mp4", "webm", "ogg",
  ]);

  /** Strips diacritics so "ściągnij"/"sciagnij" and "Odtwórz"/"odtworz" hit the same entry. */
  const foldLabel = (text) =>
    text
      .toLowerCase()
      .normalize("NFD")
      // NFD splits "ś" into "s" plus a combining mark; drop the mark rather than let the
      // next replace turn it into a space and break the word in two.
      .replace(/\p{Diacritic}/gu, "")
      // Letters and digits of every script survive. Folding down to a-z0-9 emptied out
      // Cyrillic, CJK and Greek titles, and an empty label counts as generic, so every
      // title on such a page was thrown away in favour of the file name.
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const isGenericLabel = (text) => {
    const folded = foldLabel(text);
    if (!folded) return true;
    // Bare numbers, "1080p", "▶" and friends say nothing about the video either.
    if (/^\d+(\s*p|\s*px|\s*mb|\s*gb)?$/.test(folded)) return true;
    // Download tables put file size and resolution in their own columns, so the row text
    // reads "5 1920 x 1080". The file name beats that every time.
    if (/^[\d\s.,:+x×p-]*$/i.test(folded)) return true;
    if (/^[\d\s.,x×p-]*(mb|gb|kb|kib|mib|gib|fps|kbps|mbps)?[\d\s.,x×p-]*$/i.test(folded)) return true;
    return GENERIC_LABELS.has(folded);
  };

  const collapse = (value) =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

  const normalizeText = (value, maxLength = MAX_TITLE_LENGTH) => {
    const text = collapse(value);
    if (!text) return null;
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  };

  const attr = (element, name) => (element ? element.getAttribute(name) : null);

  /** Resolves a possibly relative src/href into an absolute, linkable URL. */
  const toAbsoluteUrl = (value) => {
    if (!value || typeof value !== "string") return null;
    try {
      const url = new URL(value.trim(), document.baseURI);
      return ALLOWED_PROTOCOLS.includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };

  /** Extension check runs on the pathname so ?query and #hash never mask it. */
  const extensionOf = (absoluteUrl) => {
    try {
      const match = new URL(absoluteUrl).pathname.match(EXTENSION_PATTERN);
      return match ? match[1].toLowerCase() : null;
    } catch {
      return null;
    }
  };

  const fileNameFromUrl = (absoluteUrl) => {
    let segment = "";
    try {
      segment = new URL(absoluteUrl).pathname.split("/").pop() || "";
    } catch {
      return "";
    }
    try {
      return decodeURIComponent(segment);
    } catch {
      // A stray percent sign makes decodeURIComponent throw; the raw segment still beats
      // falling back to the whole URL, which is what used to end up in the file column.
      return segment;
    }
  };

  /**
   * Last-resort title: "my-holiday_clip.final.mp4" -> "My holiday clip final". Returns an
   * empty string when the URL carries no usable name; the popup puts a localized label
   * there, so no English word leaks into an otherwise translated interface.
   */
  const titleFromFileName = (absoluteUrl) => {
    const cleaned = fileNameFromUrl(absoluteUrl)
      .replace(EXTENSION_PATTERN, "")
      .replace(/[-_.+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) return "";
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  };

  /**
   * Vertical resolution is the name people use: 480p, 720p, 1080p. Only the two tiers
   * that have their own names get one, and anything unusual keeps its real height rather
   * than being rounded into a tier it does not belong to.
   */
  const resolutionLabel = (height) => {
    if (!Number.isInteger(height) || height < 120 || height > 20000) return null;
    if (height >= 4320) return "8K";
    if (height >= 2160) return "4K";
    return `${height}p`;
  };

  /** Ground truth, and free: a player that has loaded knows its own dimensions. */
  const measuredResolution = (element) => {
    const height = element?.videoHeight;
    return Number.isInteger(height) && height > 0 ? { height, source: "player" } : null;
  };

  const NAMED_RESOLUTIONS = new Map([
    ["8k", 4320], ["4k", 2160], ["uhd", 2160], ["qhd", 1440], ["fullhd", 1080], ["fhd", 1080],
  ]);

  /**
   * Read out of the address: "clip_1080p.mp4", "/vids/720/clip.mp4", "movie-4k.webm".
   * A guess, not a measurement, so the popup says where it came from. A bare "hd" is
   * deliberately ignored - it has meant anything from 720 to 1080 for twenty years.
   */
  const addressResolution = (absoluteUrl) => {
    let path = "";
    try {
      path = decodeURIComponent(new URL(absoluteUrl).pathname).toLowerCase();
    } catch {
      return null;
    }

    const tagged = path.match(/(?:^|[^\d])(\d{3,4})p(?:[^a-z0-9]|$)/);
    if (tagged) return { height: Number(tagged[1]), source: "address" };

    for (const [name, height] of NAMED_RESOLUTIONS) {
      if (new RegExp(`(?:^|[^a-z0-9])${name}(?:[^a-z0-9]|$)`).test(path)) {
        return { height, source: "address" };
      }
    }
    // A path segment or file-name token that is nothing but the number: /1080/, _720_.
    const bare = path.match(/(?:^|[^\d])(240|360|480|540|576|720|1080|1440|2160|4320)(?:[^\d]|$)/);
    return bare ? { height: Number(bare[1]), source: "address" } : null;
  };

  /** "1920 x 1080" or "1080p" written next to the link, in a table cell or a caption. */
  const textResolution = (text) => {
    const collapsed = collapse(text).toLowerCase();
    if (!collapsed) return null;

    const pair = collapsed.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/);
    if (pair) return { height: Number(pair[2]), source: "page" };

    const tagged = collapsed.match(/(?:^|[^\d])(\d{3,4})p(?:[^a-z0-9]|$)/);
    return tagged ? { height: Number(tagged[1]), source: "page" } : null;
  };

  /** First source that yields a usable height wins; order decides which one that is. */
  const pickResolution = (sources) => {
    for (const source of sources) {
      const found = typeof source === "function" ? source() : source;
      const label = resolutionLabel(found?.height);
      if (label) return { resolution: label, resolutionSource: found.source };
    }
    return { resolution: null, resolutionSource: null };
  };

  /** og:title beats document.title - it lacks the " - CDA"-style site suffix. */
  const pageTitle = (() => {
    const meta =
      attr(document.querySelector('meta[property="og:title"]'), "content") ??
      attr(document.querySelector('meta[name="twitter:title"]'), "content");
    return normalizeText(meta) ?? normalizeText(document.title);
  })();

  const HEADINGS = "h1, h2, h3, h4, h5, h6, figcaption, [role='heading']";
  /**
   * Climbing out of one of these means leaving the video's own context: the page <h1> or
   * a whole table is no longer a description of this particular file.
   */
  const CONTEXT_BOUNDARIES = "body, main, article, section, nav, header, footer, aside, form, table, tbody, ul, ol";

  /** Ancestors from the element up to (but not through) the nearest context boundary. */
  const climb = (element, maxDepth) => {
    const chain = [];
    let node = element.parentElement;

    for (let depth = 0; depth < maxDepth && node && !node.matches(CONTEXT_BOUNDARIES); depth++) {
      chain.push(node);
      node = node.parentElement;
    }
    return chain;
  };

  /**
   * Caption-style heading right above the player. Only the few nearest siblings count -
   * scanning further back drifts into headings that belong to another video.
   */
  const precedingHeading = (element) => {
    const MAX_SIBLINGS = 3;

    for (const node of [element, ...climb(element, 3)]) {
      let sibling = node.previousElementSibling;
      for (let seen = 0; sibling && seen < MAX_SIBLINGS; seen++, sibling = sibling.previousElementSibling) {
        const heading = sibling.matches(HEADINGS) ? sibling : sibling.querySelector(HEADINGS);
        const text = normalizeText(heading?.textContent);
        if (text && !isGenericLabel(text)) return text;
      }
    }
    return null;
  };

  /**
   * Text of a close ancestor (table row, list item, card) with the element's own label
   * removed - that is where the real name usually sits on "Download" listings.
   */
  const ancestorContext = (element) => {
    // Both sides of the subtraction stay untruncated: comparing a 120-character excerpt
    // with the full ancestor text never matched, so the element's own label survived in
    // the context that was supposed to remove it.
    const own = collapse(element.textContent);

    for (const node of climb(element, 3)) {
      const heading = node.querySelector(HEADINGS);
      const headingText = normalizeText(heading?.textContent);
      if (headingText && !isGenericLabel(headingText)) return headingText;

      const raw = collapse(node.textContent);
      const candidate = collapse(own ? raw.replace(own, " ") : raw);
      if (candidate && candidate.length <= MAX_CONTEXT_LENGTH && !isGenericLabel(candidate)) {
        return normalizeText(candidate);
      }
    }
    return null;
  };

  /**
   * Raw text of the nearest row-like ancestors, joined. ancestorContext deliberately
   * rejects rows that are nothing but numbers - which is exactly where a download table
   * prints "5 1920 x 1080", so resolution needs the unfiltered version.
   */
  const rowText = (element) =>
    climb(element, 3)
      .map((node) => collapse(node.textContent))
      .join(" ")
      .slice(0, 400);

  /** First candidate that is neither empty nor a generic action label wins. */
  const pickTitle = (candidates, absoluteUrl) => {
    for (const candidate of candidates) {
      const text = normalizeText(typeof candidate === "function" ? candidate() : candidate);
      if (text && !isGenericLabel(text)) return text;
    }
    // Through normalizeText as well, so every title obeys the same length limit.
    return normalizeText(titleFromFileName(absoluteUrl)) ?? "";
  };

  const found = new Map();

  /**
   * `resolutionSources` are tried before the address, so a measurement or a number
   * printed on the page always beats a guess read out of the file name.
   */
  const add = (rawUrl, candidates, resolutionSources = []) => {
    const absoluteUrl = toAbsoluteUrl(rawUrl);
    if (!absoluteUrl) return;

    const extension = extensionOf(absoluteUrl);
    if (!extension) return;
    // First occurrence wins - earlier markup usually carries the richer title.
    if (found.has(absoluteUrl)) return;

    found.set(absoluteUrl, {
      url: absoluteUrl,
      title: pickTitle(candidates, absoluteUrl),
      fileName: fileNameFromUrl(absoluteUrl) || absoluteUrl,
      extension,
      isStream: STREAM_EXTENSIONS.includes(extension),
      ...pickResolution([...resolutionSources, () => addressResolution(absoluteUrl)]),
    });
  };

  // --- Pass 1: media elements and links --------------------------------------

  // <video src="...">
  for (const video of document.querySelectorAll("video[src]")) {
    add(attr(video, "src"), [
      attr(video, "title"),
      attr(video, "aria-label"),
      attr(video, "alt"),
      attr(video, "data-title"),
      () => precedingHeading(video),
      () => ancestorContext(video),
    ], [
      () => measuredResolution(video),
      () => textResolution(rowText(video)),
    ]);
  }

  // <video><source src="..."></video> (also covers <audio>)
  for (const source of document.querySelectorAll("source[src]")) {
    const parent = source.closest("video, audio");
    add(attr(source, "src"), [
      attr(source, "title"),
      attr(source, "aria-label"),
      attr(parent, "title"),
      attr(parent, "aria-label"),
      attr(parent, "alt"),
      () => (parent ? precedingHeading(parent) : null),
      () => (parent ? ancestorContext(parent) : null),
    ], [
      () => measuredResolution(parent),
      () => textResolution(parent ? rowText(parent) : rowText(source)),
    ]);
  }

  // <a href="...">
  for (const link of document.querySelectorAll("a[href]")) {
    const image = link.querySelector("img[alt]");
    add(attr(link, "href"), [
      attr(link, "title"),
      link.textContent,
      attr(link, "aria-label"),
      attr(image, "alt"),
      // No precedingHeading here on purpose: a download link's nearest heading is usually
      // the section title shared by the whole list, which the file name beats.
      () => ancestorContext(link),
    ], [
      () => textResolution(rowText(link)),
    ]);
  }

  // --- Pass 2: sweep the serialized markup -----------------------------------
  // Players built by JS (cda.pl and friends) keep their manifest URL inside an inline
  // script or a data attribute, so no selector above can reach it.

  /**
   * Every run is bounded. A lazy `+?` before the extension makes the engine rescan an
   * unbroken run of characters for each `//` it passes, which is quadratic in the length
   * of that run rather than linear in the document: a 4 MB blob of near-misses took five
   * minutes of a page's main thread. No real URL is longer than this bound anyway.
   */
  const MAX_URL_LENGTH = 2048;

  const ABSOLUTE_URL_PATTERN = new RegExp(
    `(?:https?://|//)[^\\s"'\`<>()\\[\\]{}\\\\]{1,${MAX_URL_LENGTH}}?` +
      `\\.(?:${ALL_EXTENSIONS.join("|")})\\b(?:\\?[^\\s"'\`<>()]{0,${MAX_URL_LENGTH}})?`,
    "gi",
  );
  const QUOTED_RELATIVE_URL_PATTERN = new RegExp(
    `["'](/[^\\s"'<>]{1,${MAX_URL_LENGTH}}?\\.(?:${ALL_EXTENSIONS.join("|")}))` +
      `(\\?[^\\s"'<>]{0,${MAX_URL_LENGTH}})?["']`,
    "gi",
  );

  const markup = document.documentElement?.outerHTML ?? "";
  if (markup && markup.length <= MAX_MARKUP_LENGTH) {
    // JSON embedded in attributes escapes its slashes ("https:\/\/…") and HTML-escapes "&".
    const flattened = markup.replace(/\\\//g, "/").replace(/&amp;/gi, "&");
    const blobCandidates = [pageTitle];

    /**
     * Players that hide their manifest in a JSON blob usually state the dimensions right
     * next to it: cda.pl ships "width":1920,"height":1080 in the same attribute. Only used
     * when every pair in the document agrees, so an ad or a thumbnail cannot mislabel it.
     */
    const markupResolution = (() => {
      const pairs = new Set(
        [...flattened.matchAll(/"width"\s*:\s*"?(\d{3,5})"?\s*,\s*"height"\s*:\s*"?(\d{3,5})"?/g)]
          .map(([, , height]) => height),
      );
      if (pairs.size !== 1) return null;
      return { height: Number([...pairs][0]), source: "page" };
    })();

    const blobResolution = [() => markupResolution];

    for (const [match] of flattened.matchAll(ABSOLUTE_URL_PATTERN)) {
      add(match, blobCandidates, blobResolution);
    }
    for (const [, path, query] of flattened.matchAll(QUOTED_RELATIVE_URL_PATTERN)) {
      add(`${path}${query ?? ""}`, blobCandidates, blobResolution);
    }
  }

  // Plain files first - they are the ones you can actually save with one click.
  return Array.from(found.values()).sort((a, b) => Number(a.isStream) - Number(b.isStream));
})();
