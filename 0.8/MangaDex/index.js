// ============================================================================
// MangaDex — Paperback 0.8 extension
// Ported from the Aidoku "MangaDex" source (0.9, extensions-master, minified).
//
// MangaDex is API-only (https://api.mangadex.org) — no HTML parsing is needed.
// The 0.9 logic and API parameters are kept as-is; only the plumbing was adapted:
//   - Application.scheduleRequest / Application.getState  -> App.createRequest +
//     requestManager.schedule + App.createSourceStateManager
//   - Aidoku manga/chapter objects -> App.createSourceManga / createChapter / ...
//   - 0.9 discover sections        -> getHomePageSections + getViewMoreItems
//   - 0.9 advanced search form     -> extra tag sections (prefix-encoded ids)
//   - Login / auth token handling  -> skipped (public API only)
//   - 0.9 settings UI              -> fixed defaults (no SETTINGS_UI intent)
//
// Known simplifications are listed in README.md next to this file.
// ============================================================================
(function (factory) {
  if (typeof exports === "object" && typeof module !== "undefined") {
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    define([], factory);
  } else {
    var g;
    if (typeof window !== "undefined") { g = window; }
    else if (typeof global !== "undefined") { g = global; }
    else if (typeof self !== "undefined") { g = self; }
    else { g = this; }
    var exports = factory();
    g.Sources = g.Sources || {};
    for (var k in exports) { if (Object.prototype.hasOwnProperty.call(exports, k)) { g.Sources[k] = exports[k]; } }
  }
})(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants (ported from the 0.9 source)
  // ---------------------------------------------------------------------------
  var MANGADEX_URL = "https://mangadex.org";
  var API_BASE = "https://api.mangadex.org";
  var COVERS_BASE = "https://uploads.mangadex.org/covers";
  var RETRY = 3;

  // Content ratings (0.9: Ee). "paperback" mirrors Aidoku's ContentRating enum.
  var RATINGS = [
    { enum: "safe", paperback: "EVERYONE", name: "Safe (EVERYONE)", shortName: "Safe", default: true },
    { enum: "suggestive", paperback: "MATURE", name: "Suggestive (TEEN)", shortName: "Suggestive", default: true },
    { enum: "erotica", paperback: "ADULT", name: "Erotica (ADULT)", shortName: "Erotica" },
    { enum: "pornographic", paperback: "ADULT", name: "Mature (ADULT)", shortName: "Mature" }
  ];
  // Publication statuses (0.9: Ae). searchable = offered as a search filter.
  var STATUSES = [
    { enum: "ongoing", name: "Ongoing", searchable: true },
    { enum: "completed", name: "Completed", searchable: true },
    { enum: "publishing_finished", name: "Publishing Finished", searchable: false },
    { enum: "hiatus", name: "Hiatus", searchable: true },
    { enum: "cancelled", name: "Cancelled", searchable: true }
  ];
  // Cover quality (0.9: je). "ending" is appended to the file name.
  var THUMBNAIL_QUALITIES = [
    { name: "Source (Original/Best)", enum: "source", ending: "", defaultFor: ["manga"] },
    { name: "<= 512px", enum: "512", ending: ".512.jpg", defaultFor: ["discover", "search"] },
    { name: "<= 256px", enum: "256", ending: ".256.jpg", defaultFor: [] }
  ];
  var DEMOGRAPHICS = [
    { name: "None", enum: "none" },
    { name: "Shounen", enum: "shounen" },
    { name: "Shoujo", enum: "shoujo" },
    { name: "Seinen", enum: "seinen" },
    { name: "Josei", enum: "josei" }
  ];
  var ORIGINAL_LANGUAGES = [
    { name: "Japanese (Manga)", enum: "ja" },
    { name: "Korean (Manhwa)", enum: "ko" },
    { name: "Chinese (Manhua)", enum: "zh", extraCodes: ["zh-hk"] }
  ];
  // 0.9: no sorting UI in 0.8 — these become a "Sort Order" tag section.
  var SORT_OPTIONS = [
    { id: "order[latestUploadedChapter]-desc", label: "Latest Upload" },
    { id: "order[relevance]-desc", label: "Best Match" },
    { id: "order[latestUploadedChapter]-asc", label: "Oldest Upload" },
    { id: "order[title]-asc", label: "Title Ascending" },
    { id: "order[title]-desc", label: "Title Descending" },
    { id: "order[rating]-desc", label: "Highest Rating" },
    { id: "order[rating]-asc", label: "Lowest Rating" },
    { id: "order[followedCount]-desc", label: "Most Follows" },
    { id: "order[followedCount]-asc", label: "Least Follows" },
    { id: "order[createdAt]-desc", label: "Recently Added" },
    { id: "order[createdAt]-asc", label: "Oldest Added" },
    { id: "order[year]-asc", label: "Year Ascending" },
    { id: "order[year]-desc", label: "Year Descending" }
  ];
  var TITLE_LANGUAGES = ["en"];            // 0.9 language_priority default
  var ROMANIZED_LANGUAGES = ["ja-ro", "ko-ro", "zh-ro"];
  var SEASON_INDEX = { winter: 0, spring: 1, summer: 2, fall: 3 };
  var TAG_CACHE_KEY = "mangadex_tag_cache";
  var TAG_CACHE_TTL_MS = 2592e6;           // 30 days (0.9)
  var CURATED_CACHE_KEY = "mangadex_curated_lists_cache";
  var CURATED_CACHE_TTL_MS = 6048e5;       // 7 days (0.9)
  var CURATED_USER_ID = "d2ae45e0-b5e2-4e7f-a688-17925c2d7d6b";
  // Hardcoded fallbacks (0.9: Zi) — used when curated-list discovery fails.
  var CURATED_FALLBACKS = {
    seasonal: "68ab4f4e-6f01-4898-9038-c5eee066be27",
    recommended: "805ba886-dd99-4aa4-b460-4bd7c7b71352",
    selfPublished: "f66ebc10-ef89-46d1-be96-bb704559e04a"
  };
  var HOME_SECTIONS = [
    { id: "popular", title: "Popular New Titles", type: "prominentCarousel", containsMoreItems: true },
    { id: "latest_updates", title: "Latest Updates", type: "chapterUpdates", containsMoreItems: true },
    { id: "recommended", title: "Recommended", type: "simpleCarousel", containsMoreItems: false },
    { id: "self_published", title: "Self-Published", type: "simpleCarousel", containsMoreItems: false },
    { id: "seasonal", title: "Seasonal", type: "featured", containsMoreItems: false },
    { id: "recently_added", title: "Recently Added", type: "simpleCarousel", containsMoreItems: true }
  ];
  var UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  var UUID_REGEX = new RegExp("^" + UUID_PATTERN + "$", "i");
  var UUID_ANYWHERE_REGEX = new RegExp(UUID_PATTERN, "i");
  var LEGACY_ID_REGEX = /^\d+$/;
  var URL_QUERY_REGEX = new RegExp("mangadex\\.org\\/(title|chapter|group|author|user|list)\\/([0-9a-fA-F-]{36}|\\d+)", "i");
  var PREFIX_QUERY_REGEX = new RegExp("^(id|ch|grp|usr|author|list):\\s*(" + UUID_PATTERN + "|\\d+)\\s*$", "i");
  var PREFIX_MAP = { title: "id", chapter: "ch", group: "grp", author: "author", user: "usr", list: "list" };
  var CONTENT_RATING_BY_ID = (function () {
    var map = {};
    for (var i = 0; i < RATINGS.length; i++) { map[String(i + 1)] = RATINGS[i].enum; }
    return map;
  })();

  // ---------------------------------------------------------------------------
  // Settings — 0.9 defaults (the 0.8 build has no settings UI / SETTINGS_UI)
  // ---------------------------------------------------------------------------
  var SETTINGS = {
    languages: ["en"],
    ratings: RATINGS.filter(function (r) { return r.default; }).map(function (r) { return r.enum; }),
    data_saver: false,
    force_port_443: false,
    skip_same_chapter: false,
    include_unavailable: false,
    show_volume_in_subtitle: true,
    show_chapter_in_subtitle: true,
    compact_subtitle: false,
    show_search_rating_subtitle: false,
    relevance_scoring_enabled: true,
    manga_thumbnail: "source",
    discover_thumbnail: "512",
    search_thumbnail: "512",
    group_blocking_enabled: false,
    fuzzy_blocking_enabled: false,
    blocked_groups: {},
    blocked_uploaders: [],
    try_first_volume_cover: false,
    show_alt_titles_in_synopsis: false,
    show_final_chapter_in_synopsis: false,
    native_title_display: "none"
  };

  function thumbEnding(kind) {
    var wanted = kind === "manga" ? SETTINGS.manga_thumbnail : (kind === "search" ? SETTINGS.search_thumbnail : SETTINGS.discover_thumbnail);
    for (var i = 0; i < THUMBNAIL_QUALITIES.length; i++) {
      if (THUMBNAIL_QUALITIES[i].enum === wanted) { return THUMBNAIL_QUALITIES[i].ending; }
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Small generic helpers
  // ---------------------------------------------------------------------------
  var hasOwn = Object.prototype.hasOwnProperty;

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) { out.push(list.slice(i, i + size)); }
    return out;
  }

  function isUuid(value) {
    return typeof value === "string" && UUID_REGEX.test(value);
  }

  function isLegacyId(value) {
    return typeof value === "string" && LEGACY_ID_REGEX.test(value);
  }

  function toPositiveInt(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // 0.9: bt()
  function parseDate(value) {
    if (value === null || value === undefined || value === "") { return undefined; }
    var d = new Date(value);
    return isNaN(d.getTime()) ? undefined : d;
  }

  // 0.9: yt()
  function parseDateOrZero(value) {
    var d = new Date(value === null || value === undefined ? 0 : value);
    return isNaN(d.getTime()) ? new Date(0) : d;
  }

  // 0.9: vt() — ISO string without milliseconds for publishAtSince.
  function toIsoSeconds(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) { return undefined; }
    return date.toISOString().replace(/\.\d{3}Z$/, "");
  }

  // 0.9: _t() — midnight UTC of a timestamp, ISO without ms (createdAtSince).
  function startOfUtcDayIso(ms) {
    var d = new Date(ms);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 19);
  }

  // Tiny HTML entity decoder (0.9 uses Application.decodeHTMLEntities).
  function decodeHtmlEntities(text) {
    var named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };
    return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (match, body) {
      if (body.charAt(0) === "#") {
        var code = body.charAt(1) === "x" || body.charAt(1) === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try { return String.fromCodePoint(code); } catch (e) { return match; }
        }
        return match;
      }
      return hasOwn.call(named, body.toLowerCase()) ? named[body.toLowerCase()] : match;
    });
  }

  // 0.9: St() — decode entities only when needed.
  function cleanText(value) {
    if (!value) { return value || ""; }
    var s = String(value);
    if (s.indexOf("&") < 0) { return s; }
    try { return decodeHtmlEntities(s) || s; } catch (e) { return s; }
  }

  // 0.9: La()
  function groupTitle(group) {
    var s = String(group || "tags");
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
  }

  // 0.9: Te.getFlagCode — the 0.9 build stores flag emojis; Paperback wants the
  // language code itself, so chapters use the MangaDex language code.
  function languageCode(code) {
    return code || "en";
  }

  // ---------------------------------------------------------------------------
  // Relevance scoring (0.9: Et / Dt / At / kt / jt / Ue)
  // The 0.9 build runs search titles through a full English stemmer; this port
  // keeps the scoring ladder but uses plain lowercased words (see README).
  // ---------------------------------------------------------------------------
  function normalizeSearchWords(text) {
    return String(text)
      .toLowerCase()
      .replace(/[\u2019']/g, "")
      .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
      .split(/[\s\-_]+/)
      .filter(function (w) { return w.length > 0; });
  }

  function levenshtein(a, b) {
    if (a === b) { return 0; }
    var la = a.length, lb = b.length;
    if (la === 0) { return lb; }
    if (lb === 0) { return la; }
    var prev = new Array(lb + 1);
    var cur = new Array(lb + 1);
    var i, j;
    for (j = 0; j <= lb; j++) { prev[j] = j; }
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var swap = prev; prev = cur; cur = swap;
    }
    return prev[lb];
  }

  // 0.9: jt()
  function fuzzyRatio(a, b) {
    if (a === b) { return 1; }
    var min = Math.min(a.length, b.length);
    var max = Math.max(a.length, b.length);
    if (min >= 3 && min / max >= 0.5 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) { return 0.8; }
    var ratio = (max - levenshtein(a, b)) / max;
    return ratio >= 0.6 ? ratio : 0;
  }

  // 0.9: Et()
  function buildSearchText(text) {
    var words = normalizeSearchWords(text);
    var phrase = words.join(" ");
    var stripped = words.join("");
    var escaped = escapeRegExp(phrase);
    var hasAlnum = /[A-Za-z0-9]/.test(phrase);
    return {
      words: words,
      phrase: phrase,
      stripped: stripped,
      startRegex: hasAlnum ? new RegExp("^" + escaped + "\\b", "i") : null,
      anywhereRegex: hasAlnum ? new RegExp("\\b" + escaped + "\\b", "i") : null
    };
  }

  // 0.9: At()
  function findWordSequence(titleWords, searchWords) {
    if (searchWords.length === 0 || titleWords.length < searchWords.length) { return -1; }
    for (var start = 0; start <= titleWords.length - searchWords.length; start++) {
      var ok = true;
      for (var i = 0; i < searchWords.length; i++) {
        if (fuzzyRatio(searchWords[i], titleWords[start + i]) < 0.7) { ok = false; break; }
      }
      if (ok) { return start; }
    }
    return -1;
  }

  // 0.9: kt()
  function countMatchedWords(titleWords, searchWords) {
    var count = 0;
    for (var i = 0; i < searchWords.length; i++) {
      for (var j = 0; j < titleWords.length; j++) {
        if (fuzzyRatio(searchWords[i], titleWords[j]) >= 0.7) { count++; break; }
      }
    }
    return count;
  }

  // 0.9: Dt()
  function scoreTitleMatch(title, searchText) {
    if (searchText.words.length === 0) { return 0; }
    var words = normalizeSearchWords(title);
    if (words.join("") === searchText.stripped) { return 100; }
    var phrase = words.join(" ");
    if (searchText.startRegex && searchText.startRegex.test(phrase)) { return 99; }
    if (searchText.anywhereRegex && searchText.anywhereRegex.test(phrase)) { return 95; }
    var index = findWordSequence(words, searchText.words);
    if (index === 0) { return 90; }
    if (index > 0) { return 85; }
    // All search words present (first fuzzy hit each) and in strictly increasing order?
    var positions = new Array(searchText.words.length);
    var allFound = true;
    for (var w = 0; w < searchText.words.length; w++) {
      var pos = -1;
      for (var t = 0; t < words.length; t++) {
        if (fuzzyRatio(searchText.words[w], words[t]) >= 0.7) { pos = t; break; }
      }
      positions[w] = pos;
      if (pos < 0) { allFound = false; }
    }
    if (allFound) {
      var increasing = true;
      for (var p = 1; p < positions.length; p++) {
        if (positions[p] <= positions[p - 1]) { increasing = false; break; }
      }
      if (!increasing) {
        increasing = true;
        var cursor = 0;
        for (var q = 0; q < searchText.words.length; q++) {
          var found = -1;
          for (var r = cursor; r < words.length; r++) {
            if (fuzzyRatio(searchText.words[q], words[r]) >= 0.7) { found = r; break; }
          }
          if (found < 0) { increasing = false; break; }
          cursor = found + 1;
        }
      }
      return increasing ? 80 : 75;
    }
    var coverage = countMatchedWords(words, searchText.words) / searchText.words.length;
    var similarity = 0;
    for (var s = 0; s < searchText.words.length; s++) {
      var best = 0;
      for (var u = 0; u < words.length; u++) {
        var score = fuzzyRatio(searchText.words[s], words[u]);
        if (score > best) { best = score; }
      }
      similarity += best;
    }
    return (similarity / searchText.words.length) * 70 * coverage;
  }

  // ---------------------------------------------------------------------------
  // URL builder (0.9: the _e class) — path components + query items.
  // ---------------------------------------------------------------------------
  function UrlBuilder(base) {
    this.base = String(base).replace(/\/$/, "");
    this.path = "";
    this.queryItems = {};
  }
  UrlBuilder.prototype.addPathComponent = function (component) {
    var c = String(component);
    this.path += c.charAt(0) === "/" ? c : "/" + c;
    return this;
  };
  UrlBuilder.prototype.setQueryItem = function (key, value) {
    this.queryItems[key] = value;
    return this;
  };
  UrlBuilder.prototype.toString = function () {
    var parts = [];
    var keys = Object.keys(this.queryItems);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = this.queryItems[key];
      if (value === undefined || value === null) { continue; }
      if (Array.isArray(value)) {
        if (value.length === 0) { continue; }
        for (var j = 0; j < value.length; j++) {
          parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value[j]));
        }
      } else {
        parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
      }
    }
    return this.base + this.path + (parts.length ? "?" + parts.join("&") : "");
  };

  function buildUrl(path) {
    return new UrlBuilder(API_BASE).addPathComponent(path);
  }

  // 0.9: wr() — only add array query params when non-empty.
  function setIfAny(url, key, values) {
    if (values && values.length > 0) { url.setQueryItem(key, values); }
    return url;
  }

  // ---------------------------------------------------------------------------
  // API endpoint builders (ported 1:1 from the 0.9 source)
  // ---------------------------------------------------------------------------
  function mangaDetailsUrl(mangaId, includes) {           // 0.9: Er()
    var url = buildUrl("manga").addPathComponent(mangaId);
    if (includes && includes.length > 0) { url.setQueryItem("includes[]", includes); }
    return url;
  }
  function statisticsUrl(mangaId) {                       // 0.9: Fr()
    return buildUrl("statistics").addPathComponent("manga").addPathComponent(mangaId);
  }
  function statisticsByIdsUrl(mangaIds) {                 // 0.9: Ir()
    return buildUrl("statistics").addPathComponent("manga").setQueryItem("manga[]", mangaIds);
  }
  function aggregateUrl(mangaId, languages) {             // 0.9: Or()
    var url = buildUrl("manga").addPathComponent(mangaId).addPathComponent("aggregate");
    return setIfAny(url, "translatedLanguage[]", languages);
  }
  function coversUrl(options) {                           // 0.9: Vr()
    var url = buildUrl("cover")
      .setQueryItem("manga[]", [options.mangaId])
      .setQueryItem("limit", String(options.limit))
      .setQueryItem("order[volume]", options.orderVolume || "asc");
    return setIfAny(url, "locales[]", options.locales);
  }
  function atHomeUrl(chapterId, forcePort443) {           // 0.9: Pr()
    return API_BASE + "/at-home/server/" + chapterId + (forcePort443 ? "?forcePort443=true" : "");
  }
  function tagsUrl() {                                    // 0.9: Br()
    return API_BASE + "/manga/tag";
  }
  function listUrl(listId) {                              // 0.9: Lr()
    return API_BASE + "/list/" + listId;
  }
  function userListUrl(userId, limit) {                   // 0.9: Rr()
    return buildUrl("user").addPathComponent(userId).addPathComponent("list").setQueryItem("limit", String(limit));
  }
  function legacyMappingUrl() {                           // 0.9: zr()
    return API_BASE + "/legacy/mapping";
  }
  function chapterByIdUrl(chapterId, includes) {          // 0.9: Nr()
    var url = buildUrl("chapter").addPathComponent(chapterId);
    return setIfAny(url, "includes[]", includes);
  }
  function chaptersByIdsUrl(options) {                    // 0.9: jr()
    return buildUrl("chapter")
      .setQueryItem("ids[]", options.chapterIds)
      .setQueryItem("limit", String(options.chapterIds.length))
      .setQueryItem("translatedLanguage[]", options.languages)
      .setQueryItem("contentRating[]", options.ratings)
      .setQueryItem("includeFutureUpdates", options.includeFutureUpdates ? "1" : "0");
  }
  function chapterListUrl(options) {                      // 0.9: Mr()
    var url = buildUrl("chapter")
      .setQueryItem("limit", String(options.limit))
      .setQueryItem("offset", String(options.offset))
      .setQueryItem("translatedLanguage[]", options.languages)
      .setQueryItem("contentRating[]", options.ratings)
      .setQueryItem("order[readableAt]", "desc")
      .setQueryItem("includeFutureUpdates", "0");
    setIfAny(url, "uploader[]", options.uploaders);
    setIfAny(url, "excludedUploaders[]", options.excludedUploaders);
    setIfAny(url, "includes[]", options.includes);
    return url;
  }
  function mangaListUrl(options) {                        // 0.9: Tr()
    var url = buildUrl("manga")
      .setQueryItem("limit", String(options.limit))
      .setQueryItem("contentRating[]", options.ratings);
    setIfAny(url, "availableTranslatedLanguage[]", options.languages);
    setIfAny(url, "includes[]", options.includes || ["cover_art"]);
    setIfAny(url, "ids[]", options.ids);
    setIfAny(url, "publicationDemographic[]", options.demographics);
    setIfAny(url, "status[]", options.statuses);
    setIfAny(url, "originalLanguage[]", options.originalLanguages);
    if (options.offset !== undefined) { url.setQueryItem("offset", String(options.offset)); }
    if (options.hasAvailableChapters) { url.setQueryItem("hasAvailableChapters", "true"); }
    if (options.orderKey && options.orderValue) { url.setQueryItem(options.orderKey, options.orderValue); }
    if (options.year !== undefined) { url.setQueryItem("year", String(options.year)); }
    if (options.authorOrArtist) { url.setQueryItem("authorOrArtist", options.authorOrArtist); }
    if (options.group) { url.setQueryItem("group", options.group); }
    if (options.title) { url.setQueryItem("title", options.title); }
    if (options.createdAtSince) { url.setQueryItem("createdAtSince", options.createdAtSince); }
    return url;
  }
  function mangaFeedUrl(options) {                        // 0.9: Dr()
    var url = buildUrl("manga").addPathComponent(options.mangaId).addPathComponent("feed")
      .setQueryItem("limit", "500")
      .setQueryItem("offset", String(options.offset))
      .setQueryItem("includes[]", options.includes)
      .setQueryItem("excludedGroups[]", options.blockedGroups)
      .setQueryItem("order[chapter]", "desc")
      .setQueryItem("order[volume]", "desc")
      .setQueryItem("order[createdAt]", "desc")
      .setQueryItem("contentRating[]", options.ratings)
      .setQueryItem("translatedLanguage[]", options.languages)
      .setQueryItem("includeFutureUpdates", "0");
    setIfAny(url, "excludedUploaders[]", options.blockedUploaders);
    if (options.publishAtSince) { url.setQueryItem("publishAtSince", options.publishAtSince); }
    if (options.includeUnavailable) {
      url.setQueryItem("includeUnavailable", "1");
      url.setQueryItem("includeEmptyPages", "1");
      url.setQueryItem("includeExternalUrl", "1");
    }
    return url;
  }
  function coverImageUrl(mangaId, fileName, ending) {     // 0.9: ui()
    return COVERS_BASE + "/" + mangaId + "/" + fileName + (ending || "");
  }

  // ---------------------------------------------------------------------------
  // Attribute / relationship parsing helpers
  // ---------------------------------------------------------------------------
  // 0.9: gi() — first present key from a title/description map.
  function firstByLanguages(map, languages) {
    if (!map) { return undefined; }
    for (var i = 0; i < languages.length; i++) {
      if (map[languages[i]]) { return map[languages[i]]; }
    }
    return undefined;
  }
  // 0.9: _i() — first present key across an altTitles array.
  function firstInAltTitles(altTitles, languages) {
    if (!altTitles) { return undefined; }
    for (var i = 0; i < languages.length; i++) {
      for (var j = 0; j < altTitles.length; j++) {
        var entry = altTitles[j];
        if (entry && typeof entry === "object" && entry[languages[i]]) { return entry[languages[i]]; }
      }
    }
    return undefined;
  }
  // 0.9: vi() — first truthy value.
  function firstValue(map) {
    if (!map) { return undefined; }
    var values = Object.keys(map).map(function (k) { return map[k]; });
    for (var i = 0; i < values.length; i++) { if (values[i]) { return values[i]; } }
    return undefined;
  }
  // 0.9: bi()
  function pickTitle(titleMap, altTitles, languages, romanizedPriority) {
    var romanized = romanizedPriority ? (firstByLanguages(titleMap, ROMANIZED_LANGUAGES) || firstInAltTitles(altTitles, ROMANIZED_LANGUAGES)) : undefined;
    var picked = romanized || firstByLanguages(titleMap, languages) || firstInAltTitles(altTitles, languages) || firstValue(titleMap) || "";
    return cleanText(picked);
  }
  // 0.9: yi()
  function allAltTitles(altTitles) {
    if (!altTitles || !altTitles.length) { return []; }
    var out = [];
    for (var i = 0; i < altTitles.length; i++) {
      var entry = altTitles[i];
      if (!entry || typeof entry !== "object") { continue; }
      var values = Object.keys(entry).map(function (k) { return entry[k]; });
      for (var j = 0; j < values.length; j++) {
        if (typeof values[j] === "string") { out.push(cleanText(values[j])); }
      }
    }
    return out;
  }
  // 0.9: ni()
  function contentRatingEnum(mdContentRating) {
    for (var i = 0; i < RATINGS.length; i++) {
      if (RATINGS[i].enum === mdContentRating) { return RATINGS[i].paperback; }
    }
    return "ADULT";
  }
  function isHentai(mdContentRating) {
    return contentRatingEnum(mdContentRating) === "ADULT";
  }
  // 0.9: oi()
  function mapStatus(status) {
    switch (status) {
      case "ongoing": return "Ongoing";
      case "completed": return "Completed";
      case "publishing_finished": return "Publishing Finished";
      case "hiatus": return "Hiatus";
      case "cancelled": return "Cancelled";
      default: return "Unknown";
    }
  }
  // 0.9: Oi()
  function groupNamesFromRelationships(relationships) {
    if (!relationships) { return []; }
    var names = [];
    for (var i = 0; i < relationships.length; i++) {
      var rel = relationships[i];
      if (rel && rel.type === "scanlation_group" && rel.attributes && rel.attributes.name) {
        names.push(rel.attributes.name);
      }
    }
    return names;
  }
  // 0.9: fi()
  function findMangaRelationship(relationships) {
    if (!relationships) { return undefined; }
    for (var i = 0; i < relationships.length; i++) {
      var rel = relationships[i];
      if (rel && rel.type === "manga" && typeof rel.id === "string" && rel.id.length > 0) { return rel; }
    }
    return undefined;
  }
  // 0.9: pi()
  function mangaIdFromRelationships(relationships) {
    var rel = findMangaRelationship(relationships);
    return rel ? rel.id.toLowerCase() : undefined;
  }
  // 0.9: di() + ui()
  function coverFromRelationships(relationships, mangaId, ending) {
    if (!relationships) { return ""; }
    for (var i = 0; i < relationships.length; i++) {
      var rel = relationships[i];
      if (rel && rel.type === "cover_art" && rel.attributes && rel.attributes.fileName) {
        return coverImageUrl(mangaId, rel.attributes.fileName, ending);
      }
    }
    return "";
  }
  // 0.9: Ei()
  function buildSubtitle(attributes, options) {
    var title = cleanText(String(attributes.title || "").trim());
    var showVolume = options.showVolume;
    var showChapter = options.showChapter;
    var compact = options.compact;
    var volumeLabel = compact ? "V." : "Vol.";
    var chapterLabel = compact ? "C." : "Ch.";
    var text = ((showVolume && attributes.volume ? volumeLabel + " " + attributes.volume + " " : "") +
      (showChapter && attributes.chapter ? chapterLabel + " " + attributes.chapter : "")).trim();
    return text && title ? text + " - " + title : (text || title);
  }
  // 0.9: ki()
  function parseChapterNumber(value, lastNumber) {
    var n = (value === null || value === undefined || value === "") ? NaN : Number(value);
    var unnumbered = isNaN(n);
    if (unnumbered) { n = lastNumber > 0 ? lastNumber - 0.001 : 0; }
    return { chapNum: n, isUnnumbered: unnumbered };
  }
  // 0.9: Ai()
  function chapterDedupeKey(chapNum, isUnnumbered, title, language, index, volume, resetOnNewVolume) {
    if (isUnnumbered) {
      return "unn-" + (String(title).trim().toLowerCase() || "idx" + index) + "-" + language;
    }
    if (resetOnNewVolume) { return volume + "-" + chapNum + "-" + language; }
    return chapNum + "-" + language;
  }
  // 0.9: si() — does the aggregate contain the final chapter?
  function aggregateHasFinalChapter(aggregate, lastChapter, lastVolume) {
    if (!lastChapter) { return false; }
    var volumes = aggregate && aggregate.volumes ? Object.keys(aggregate.volumes).map(function (k) { return aggregate.volumes[k]; }) : [];
    if (volumes.length === 0) { return false; }
    var relevant = (lastVolume !== null && lastVolume !== undefined && lastVolume !== "") ?
      volumes.filter(function (v) { return v && v.volume === lastVolume; }) : volumes;
    for (var i = 0; i < relevant.length; i++) {
      var chapters = relevant[i] && relevant[i].chapters;
      if (chapters && hasOwn.call(chapters, lastChapter)) { return true; }
    }
    return false;
  }

  // 0.9: Ti() — parse manga attributes into display data.
  function parseMangaAttributes(mangaId, attributes, aggregate) {
    var titleLanguages = TITLE_LANGUAGES;
    var primaryTitle = pickTitle(attributes.title, attributes.altTitles, titleLanguages, false);
    var preferredLanguageTitle = firstByLanguages(attributes.title, TITLE_LANGUAGES) || firstInAltTitles(attributes.altTitles, TITLE_LANGUAGES);
    preferredLanguageTitle = preferredLanguageTitle ? cleanText(preferredLanguageTitle) : undefined;
    var seen = { };
    var secondaryTitles = [];
    var alt = allAltTitles(attributes.altTitles);
    for (var i = 0; i < alt.length; i++) {
      if (alt[i] !== primaryTitle && !seen[alt[i]]) { seen[alt[i]] = true; secondaryTitles.push(alt[i]); }
    }
    var descriptionMap = attributes.description || {};
    var synopsis = cleanText(firstByLanguages(descriptionMap, titleLanguages) || descriptionMap.en || "").replace(/\[\/?[bus]]/g, "");
    var links = attributes.links || {};
    var tracking = [];
    if (links.al) { tracking.push("AniList"); }
    if (links.mu) { tracking.push("MangaUpdates"); }
    if (links.mal) { tracking.push("MyAnimeList"); }
    var synopsisParts = [];
    if (SETTINGS.show_alt_titles_in_synopsis && secondaryTitles.length > 0) {
      var extra = SETTINGS.native_title_display === "description" && preferredLanguageTitle ?
        secondaryTitles.filter(function (t) { return t !== preferredLanguageTitle; }) : secondaryTitles;
      if (extra.length > 0) { synopsisParts.push("Alternative Titles:\n" + extra.join("\n")); }
    }
    if (SETTINGS.native_title_display === "description" && preferredLanguageTitle && preferredLanguageTitle !== primaryTitle) {
      synopsisParts.push(preferredLanguageTitle);
    }
    if (synopsis) { synopsisParts.push(synopsis); }
    if (tracking.length > 0) { synopsisParts.push("Tracking available for:\n" + tracking.join("\n")); }
    if (SETTINGS.show_final_chapter_in_synopsis && attributes.status === "completed") {
      var finalParts = [];
      var lastVolume = attributes.lastVolume ? String(attributes.lastVolume).trim() : "";
      var lastChapter = attributes.lastChapter ? String(attributes.lastChapter).trim() : "";
      if (lastVolume) { finalParts.push("Vol." + lastVolume); }
      if (lastChapter) { finalParts.push("Ch." + lastChapter); }
      if (finalParts.length > 0) { synopsisParts.push("Final: " + finalParts.join(" ")); }
    }
    var status = attributes.status;
    if (status === "completed" && aggregate !== undefined && aggregate !== null &&
      !aggregateHasFinalChapter(aggregate, attributes.lastChapter, attributes.lastVolume)) {
      status = "publishing_finished";
    }
    // Tag groups (0.9 groups by attributes.group, default "tags").
    var groups = {};
    var groupOrder = [];
    var tags = attributes.tags || [];
    for (var t = 0; t < tags.length; t++) {
      var tag = tags[t];
      var group = (tag.attributes && tag.attributes.group) || "tags";
      if (!groups[group]) { groups[group] = []; groupOrder.push(group); }
      groups[group].push({
        id: tag.id,
        title: (tag.attributes && tag.attributes.name && tag.attributes.name.en) || "Unknown"
      });
    }
    var tagGroups = groupOrder.map(function (group) {
      var entries = groups[group].slice().sort(function (a, b) { return a.title.localeCompare(b.title); });
      return { id: group, title: group === "tags" ? "Tags" : groupTitle(group), tags: entries };
    }).sort(function (a, b) { return a.title.localeCompare(b.title); });
    return {
      primaryTitle: primaryTitle,
      preferredLanguageTitle: preferredLanguageTitle,
      secondaryTitles: secondaryTitles,
      synopsis: synopsisParts.join("\n\n"),
      status: status,
      tagGroups: tagGroups,
      contentRating: contentRatingEnum((attributes.contentRating || "").toLowerCase()),
      mdContentRating: (attributes.contentRating || "").toLowerCase(),
      shareUrl: MANGADEX_URL + "/title/" + mangaId
    };
  }

  // ---------------------------------------------------------------------------
  // Extension
  // ---------------------------------------------------------------------------
  var MangaDexInfo = {
    version: "1.0.0",
    name: "MangaDex",
    description: "Extension that pulls manga from MangaDex (api.mangadex.org). Ported from the Aidoku MangaDex source.",
    author: "converted",
    authorWebsite: "",
    icon: "icon.png",
    contentRating: "EVERYONE",
    websiteBaseURL: MANGADEX_URL,
    sourceTags: [{ text: "English", type: "info" }],
    // MANGA_CHAPTERS | HOMEPAGE_SECTIONS — api.mangadex.org needs no Cloudflare bypass.
    intents: 1 | 4
  };

  var MangaDex = (function () {
    function MangaDex(cheerio) {
      this.cheerio = cheerio;
      this.baseUrl = MANGADEX_URL;
      this.RETRY = RETRY;
      this.tagCache = null;
      this.requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 20000,
        interceptor: {
          interceptRequest: async (request) => {
            var headers = {};
            var src = request.headers || {};
            for (var k in src) { if (hasOwn.call(src, k)) { headers[k] = src[k]; } }
            headers["user-agent"] = await this.requestManager.getDefaultUserAgent();
            request.headers = headers;
            return request;
          },
          interceptResponse: async (response) => response,
        },
      });
      this.stateManager = App.createSourceStateManager();
    }

    // ---- settings accessors (fixed 0.9 defaults) ----
    MangaDex.prototype.getLanguages = function () { return SETTINGS.languages.slice(); };
    MangaDex.prototype.getRatings = function () { return SETTINGS.ratings.slice(); };

    // ---- low-level request plumbing ----
    MangaDex.prototype.checkResponseError = function (url, response) {
      var status = response.status;
      var text = String(response.data || "");
      var json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      if (json && json.result === "error") {
        var errors = Array.isArray(json.errors) ? json.errors : [];
        var detail = errors.length > 0 ? errors.map(function (e) {
          return "[" + e.status + "] " + (e.detail || e.title || "error");
        }).join("; ") : "HTTP " + status;
        throw new Error("MangaDex API Error: " + detail);
      }
      if (status === 404) {
        throw new Error("HTTP 404 from MangaDex for " + String(url).split("?")[0]);
      }
      if (status >= 500) {
        throw new Error(status + " MangaDex Unavailable (" + String(url).split("?")[0] + ")");
      }
      if (status >= 400) {
        throw new Error(status + " MangaDex Request Failed (" + String(url).split("?")[0] + ")");
      }
      if (json === null) {
        var head = text.slice(0, 80).replace(/\s+/g, " ");
        throw new Error("Unexpected non JSON response from MangaDex (status " + status + "): " + head);
      }
      return json;
    };

    MangaDex.prototype.apiGet = async function (url) {
      var request = App.createRequest({
        url: url,
        method: "GET",
        headers: { "Accept": "application/json" },
      });
      var response = await this.requestManager.schedule(request, this.RETRY);
      return this.checkResponseError(url, response);
    };

    MangaDex.prototype.apiPost = async function (url, body) {
      var request = App.createRequest({
        url: url,
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: body,
      });
      var response = await this.requestManager.schedule(request, this.RETRY);
      return this.checkResponseError(url, response);
    };

    // ---- id resolution (0.9: $r + legacy /legacy/mapping) ----
    MangaDex.prototype.resolveEntityId = async function (type, id) {
      if (!id) { throw new Error("Empty " + type + " id"); }
      var value = String(id).trim();
      if (!isLegacyId(value)) {
        if (!isUuid(value)) { throw new Error("Invalid " + type + " id format: " + value); }
        return value.toLowerCase();
      }
      var cacheKey = type + ":" + value;
      if (this.legacyIdCache && this.legacyIdCache[cacheKey] !== undefined) { return this.legacyIdCache[cacheKey]; }
      if (!this.legacyIdCache) { this.legacyIdCache = {}; }
      var numeric = parseInt(value, 10);
      if (!Number.isSafeInteger(numeric)) { throw new Error("Invalid legacy " + type + " id " + value); }
      var body = await this.apiPost(legacyMappingUrl(), JSON.stringify({ type: type, ids: [numeric] }));
      var entry = (body.data || []).find(function (e) {
        return e && e.attributes && e.attributes.legacyId === numeric;
      });
      var newId = entry && entry.attributes ? entry.attributes.newId : undefined;
      if (!isUuid(newId)) {
        throw new Error("Could not resolve legacy " + type + " id " + value + ". The " + type + " may have been removed from MangaDex.");
      }
      this.legacyIdCache[cacheKey] = newId.toLowerCase();
      return this.legacyIdCache[cacheKey];
    };
    MangaDex.prototype.resolveMangaId = async function (mangaId) {
      return await this.resolveEntityId("manga", mangaId);
    };
    MangaDex.prototype.resolveChapterId = async function (chapterId) {
      return await this.resolveEntityId("chapter", chapterId);
    };

    // 0.9: li()
    MangaDex.prototype.validateCollection = function (body, label) {
      if (!body || !Array.isArray(body.data)) {
        throw new Error("Failed to load results for " + label + ", check MangaDex status");
      }
      return body;
    };

    // ---- shared mapping helpers ----
    MangaDex.prototype.partialFromMangaItem = function (item, options) {
      var attributes = item.attributes || {};
      var title = pickTitle(attributes.title, attributes.altTitles, TITLE_LANGUAGES, false);
      var image = coverFromRelationships(item.relationships, item.id, thumbEnding(options.thumbnailKind || "discover"));
      var volume = attributes.lastVolume;
      var chapter = attributes.lastChapter;
      if (options.chapterAttributes) {
        // 0.9 xi(): when the latest chapter is known, its (possibly empty) values
        // replace the manga's lastVolume/lastChapter outright.
        volume = options.chapterAttributes.volume;
        chapter = options.chapterAttributes.chapter;
      }
      var subtitle = buildSubtitle({ title: undefined, volume: volume, chapter: chapter }, {
        showVolume: SETTINGS.show_volume_in_subtitle,
        showChapter: SETTINGS.show_chapter_in_subtitle,
        compact: SETTINGS.compact_subtitle
      });
      return App.createPartialSourceManga({
        mangaId: item.id,
        image: image,
        title: title,
        subtitle: subtitle,
      });
    };

    // 0.9: Ja() + xi() — map search results, adding latest-chapter subtitles and
    // optional title relevance ordering.
    MangaDex.prototype.mapSearchResults = async function (items, ratings, languages, relevanceTitle) {
      if (!items || items.length === 0) { return []; }
      var latestIds = [];
      for (var i = 0; i < items.length; i++) {
        var latest = items[i] && items[i].attributes ? items[i].attributes.latestUploadedChapter : undefined;
        if (latest && latestIds.indexOf(latest) < 0) { latestIds.push(latest); }
      }
      var chapterAttributesById = {};
      if (latestIds.length > 0) {
        try {
          var chapters = await this.apiGet(chaptersByIdsUrl({ chapterIds: latestIds, languages: languages, ratings: ratings }).toString());
          if (chapters && Array.isArray(chapters.data)) {
            for (var c = 0; c < chapters.data.length; c++) {
              var chapter = chapters.data[c];
              if (chapter && chapter.attributes) { chapterAttributesById[chapter.id] = chapter.attributes; }
            }
          }
        } catch (e) { chapterAttributesById = {}; }
      }
      var searchText = (relevanceTitle && SETTINGS.relevance_scoring_enabled) ? buildSearchText(relevanceTitle) : null;
      var mapped = [];
      for (var m = 0; m < items.length; m++) {
        var item = items[m];
        if (!item || !item.attributes) { continue; }
        var attributes = item.attributes;
        var latestId = attributes.latestUploadedChapter;
        var chapterAttributes = latestId ? chapterAttributesById[latestId] : undefined;
        var partial = this.partialFromMangaItem(item, {
          thumbnailKind: "search",
          chapterAttributes: chapterAttributes,
        });
        var relevance = 0;
        if (searchText) {
          var title = pickTitle(attributes.title, attributes.altTitles, TITLE_LANGUAGES, false);
          relevance = scoreTitleMatch(title, searchText);
          var alt = allAltTitles(attributes.altTitles);
          for (var a = 0; a < alt.length; a++) {
            var altScore = scoreTitleMatch(alt[a], searchText);
            if (altScore > relevance) { relevance = altScore; }
          }
        }
        mapped.push({ manga: partial, relevance: relevance });
      }
      if (searchText) { mapped.sort(function (a, b) { return b.relevance - a.relevance; }); }
      return mapped.map(function (entry) { return entry.manga; });
    };

    // ---- source interface ----
    MangaDex.prototype.getMangaShareUrl = function (mangaId) {
      return MANGADEX_URL + "/title/" + mangaId;
    };

    // 0.9: Di() + Si()
    MangaDex.prototype.getMangaDetails = async function (mangaId) {
      var id = await this.resolveMangaId(mangaId);
      var details;
      try {
        details = await this.apiGet(mangaDetailsUrl(id, ["author", "artist", "cover_art"]).toString());
      } catch (e) {
        var message = e instanceof Error ? e.message : String(e);
        if (message.indexOf("[404]") >= 0 || message.indexOf("HTTP 404") >= 0 || message.indexOf("404 MangaDex Request Failed") >= 0) {
          throw new Error(message + ". You may need to add this manga again");
        }
        throw e;
      }
      if (!details.data || !details.data.attributes) {
        throw new Error("MangaDex API Error: missing data field for " + id);
      }
      var statistics = null;
      try { statistics = await this.apiGet(statisticsUrl(id).toString()); } catch (e) { statistics = null; }
      var aggregate = null;
      try { aggregate = await this.apiGet(aggregateUrl(id, this.getLanguages()).toString()); } catch (e) { aggregate = null; }
      var firstVolumeCover;
      if (SETTINGS.try_first_volume_cover) {
        try {
          var covers = await this.apiGet(coversUrl({ mangaId: id, limit: 10, orderVolume: "asc" }).toString());
          var firstCover = (covers.data || []).find(function (c) {
            var volume = c && c.attributes ? c.attributes.volume : undefined;
            return volume !== null && volume !== undefined && volume !== "";
          });
          if (firstCover) { firstVolumeCover = firstCover.attributes.fileName; }
        } catch (e) { firstVolumeCover = undefined; }
      }
      return this.buildSourceManga(id, details, statistics, aggregate, firstVolumeCover);
    };

    // 0.9: Si()
    MangaDex.prototype.buildSourceManga = function (mangaId, detailsResponse, statisticsResponse, aggregate, firstVolumeCoverFileName) {
      var attributes = detailsResponse.data.attributes;
      var parsed = parseMangaAttributes(mangaId, attributes, aggregate);
      var author;
      var artist;
      var relationships = detailsResponse.data.relationships || [];
      for (var i = 0; i < relationships.length; i++) {
        var rel = relationships[i];
        if (!rel || !rel.attributes || !rel.attributes.name) { continue; }
        if (rel.type === "author" && !author) { author = rel.attributes.name; }
        if (rel.type === "artist" && !artist) { artist = rel.attributes.name; }
      }
      var image = firstVolumeCoverFileName ?
        coverImageUrl(mangaId, firstVolumeCoverFileName, thumbEnding("manga")) :
        coverFromRelationships(relationships, mangaId, thumbEnding("manga"));
      var rating = 0;
      var stats = statisticsResponse && statisticsResponse.statistics ? statisticsResponse.statistics[mangaId] : undefined;
      if (stats && stats.rating && stats.rating.average) { rating = stats.rating.average / 2; }
      var tagSections = parsed.tagGroups.map(function (group) {
        return App.createTagSection({
          id: group.id,
          label: group.title,
          tags: group.tags.map(function (tag) { return App.createTag({ id: tag.id, label: tag.title }); }),
        });
      });
      return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
          titles: [parsed.primaryTitle].concat(parsed.secondaryTitles),
          image: image,
          status: mapStatus(parsed.status),
          desc: parsed.synopsis,
          author: author,
          artist: artist,
          rating: rating,
          hentai: isHentai(parsed.mdContentRating),
          tags: tagSections,
        }),
      });
    };

    // 0.9: Ii() — paged chapter feed (500/page) mapped to Paperback chapters.
    MangaDex.prototype.getChapters = async function (mangaId) {
      var id = await this.resolveMangaId(mangaId);
      var languages = this.getLanguages();
      var languageSet = {};
      for (var i = 0; i < languages.length; i++) { languageSet[languages[i]] = true; }
      var ratings = this.getRatings();
      var includeUnavailable = SETTINGS.include_unavailable;
      var blockedGroups = SETTINGS.group_blocking_enabled ? Object.keys(SETTINGS.blocked_groups || {}) : [];
      var blockedUploaders = SETTINGS.blocked_uploaders || [];
      var fuzzyBlocking = SETTINGS.group_blocking_enabled && SETTINGS.fuzzy_blocking_enabled;
      var fuzzyTargets = fuzzyBlocking ? Object.keys(SETTINGS.blocked_groups || {}).map(function (name) {
        return normalizeSearchWords(name);
      }).filter(function (words) { return words.length > 0; }) : [];
      var skipSameChapter = SETTINGS.skip_same_chapter;
      var dedupe = skipSameChapter ? {} : null;
      var unnumberedCount = 0;
      var lastNumber = 0;
      var anyVolumeMissing = false;
      var resetOnNewVolume = false;
      var chapters = [];
      var offset = 0;
      var more = true;
      while (more) {
        var body = await this.apiGet(mangaFeedUrl({
          mangaId: id,
          offset: offset,
          includes: offset === 0 ? ["scanlation_group", "manga"] : ["scanlation_group"],
          blockedGroups: blockedGroups,
          blockedUploaders: blockedUploaders,
          ratings: ratings,
          languages: languages,
          includeUnavailable: includeUnavailable,
        }).toString());
        this.validateCollection(body, id);
        offset += 500;
        if (offset === 500) {
          var relationships = [];
          for (var d = 0; d < body.data.length; d++) {
            var rels = body.data[d] && body.data[d].relationships ? body.data[d].relationships : [];
            for (var r = 0; r < rels.length; r++) { relationships.push(rels[r]); }
          }
          var mangaRel = findMangaRelationship(relationships);
          if (mangaRel && String(mangaRel.id).toLowerCase() === id &&
            mangaRel.attributes && mangaRel.attributes.chapterNumbersResetOnNewVolume === true) {
            resetOnNewVolume = true;
          }
        }
        for (var c = 0; c < body.data.length; c++) {
          var chapter = body.data[c];
          if (!chapter || !chapter.attributes) { continue; }
          var attributes = chapter.attributes;
          if (!languageSet[attributes.translatedLanguage]) { continue; }
          var rawTitle = cleanText(attributes.title || "");
          var name = (!attributes.volume && !attributes.chapter && !rawTitle) ? "Oneshot" : rawTitle;
          var numbered = parseChapterNumber(attributes.chapter, lastNumber);
          if (numbered.isUnnumbered && skipSameChapter) { unnumberedCount++; }
          lastNumber = numbered.chapNum;
          var volume = Number(attributes.volume) || 0;
          var groups = groupNamesFromRelationships(chapter.relationships);
          var groupText = groups.join(", ");
          var pageCount = toPositiveInt(attributes.pages);
          var key;
          if (skipSameChapter) {
            key = chapterDedupeKey(numbered.chapNum, numbered.isUnnumbered, name, attributes.translatedLanguage || "", unnumberedCount, volume, resetOnNewVolume);
            if (dedupe[key]) { continue; }
          }
          if (fuzzyTargets.length > 0) {
            var blocked = false;
            for (var g = 0; g < groups.length && !blocked; g++) {
              var groupWords = normalizeSearchWords(groups[g]);
              for (var f = 0; f < fuzzyTargets.length && !blocked; f++) {
                for (var w = 0; w < fuzzyTargets[f].length && !blocked; w++) {
                  for (var gw = 0; gw < groupWords.length; gw++) {
                    if (fuzzyRatio(fuzzyTargets[f][w], groupWords[gw]) >= 0.7) { blocked = true; break; }
                  }
                }
              }
            }
            if (blocked) { continue; }
          }
          var unavailable = pageCount === 0 || !!attributes.externalUrl || attributes.isUnavailable === true;
          if (!unavailable || includeUnavailable) {
            if (!attributes.volume) { anyVolumeMissing = true; }
            chapters.push({
              id: chapter.id,
              name: unavailable ? "[Unavailable] " + name : name,
              chapNum: numbered.chapNum,
              volume: volume,
              langCode: languageCode(attributes.translatedLanguage),
              group: groupText,
              time: parseDate(attributes.publishAt),
              sortingIndex: 0,
            });
            if (key !== undefined) { dedupe[key] = true; }
          }
        }
        var total = typeof body.total === "number" ? body.total : undefined;
        if (body.data.length < 500 || total === undefined || total <= offset || offset >= 10000) { more = false; }
      }
      if (chapters.length === 0) {
        throw new Error("Couldn't find any chapters for mangaId: " + id);
      }
      if (anyVolumeMissing) {
        for (var v = 0; v < chapters.length; v++) { chapters[v].volume = 0; }
      }
      for (var s = 0; s < chapters.length; s++) { chapters[s].sortingIndex = chapters.length - s; }
      return chapters.map(function (chapter) {
        return App.createChapter({
          id: chapter.id,
          name: chapter.name,
          chapNum: chapter.chapNum,
          volume: chapter.volume,
          time: chapter.time,
          langCode: chapter.langCode,
          group: chapter.group,
          sortingIndex: chapter.sortingIndex,
        });
      });
    };

    // 0.9: Li() — page URLs come from the at-home server API.
    MangaDex.prototype.getChapterDetails = async function (mangaId, chapterId) {
      var resolvedChapterId = await this.resolveChapterId(chapterId);
      var resolvedMangaId = await this.resolveMangaId(mangaId);
      var body = await this.apiGet(atHomeUrl(resolvedChapterId, SETTINGS.force_port_443));
      if (!body.baseUrl || !body.chapter || !body.chapter.hash) {
        throw new Error("MangaDex returned malformed chapter response for " + resolvedChapterId);
      }
      var dataSaverEnabled = SETTINGS.data_saver && Array.isArray(body.chapter.dataSaver) && body.chapter.dataSaver.length > 0;
      var files = dataSaverEnabled ? body.chapter.dataSaver : body.chapter.data;
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error("MangaDex returned no pages for chapter " + resolvedChapterId);
      }
      var qualityPath = dataSaverEnabled ? "data-saver" : "data";
      var pages = files.map(function (file) {
        return body.baseUrl + "/" + qualityPath + "/" + body.chapter.hash + "/" + file;
      });
      return App.createChapterDetails({
        id: resolvedChapterId,
        mangaId: resolvedMangaId,
        pages: pages,
      });
    };

    // ---- tag list + cache (0.9: Pa / Aa / ja / Na / Ca / Fa) ----
    MangaDex.prototype.syntheticContentRatingTags = function () {
      return RATINGS.map(function (rating, index) {
        return { id: String(index + 1), group: "content_rating", name: { en: rating.shortName } };
      });
    };
    MangaDex.prototype.isValidTagCache = function (cache) {
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) { return false; }
      if (!Array.isArray(cache.tags) || typeof cache.fetchedAt !== "number") { return false; }
      if (cache.tags.length === 0) { return false; }
      for (var i = 0; i < cache.tags.length; i++) {
        var tag = cache.tags[i];
        if (!tag || typeof tag !== "object" || typeof tag.id !== "string" || tag.id === "" ||
          typeof tag.group !== "string" || tag.group === "" ||
          !tag.name || typeof tag.name !== "object" || typeof tag.name.en !== "string" || tag.name.en === "") {
          return false;
        }
      }
      return true;
    };
    MangaDex.prototype.fetchTagList = async function () {
      var body = await this.apiGet(tagsUrl());
      var apiTags = (body.data || []).map(function (tag) {
        return { id: tag.id, group: tag.attributes && tag.attributes.group, name: tag.attributes && tag.attributes.name };
      });
      var tags = this.syntheticContentRatingTags().concat(apiTags);
      if (tags.length < 40) {
        throw new Error("MangaDex /manga/tag returned only " + apiTags.length + " tags (need at least " + (40 - 4) + ")");
      }
      var cache = { tags: tags, fetchedAt: Date.now() };
      try { await this.stateManager.store(TAG_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
      return cache;
    };
    MangaDex.prototype.getTagList = async function () {
      if (this.tagCache) { return this.tagCache; }
      var cached = null;
      try {
        var raw = await this.stateManager.retrieve(TAG_CACHE_KEY);
        cached = raw ? JSON.parse(raw) : null;
      } catch (e) { cached = null; }
      if (this.isValidTagCache(cached)) {
        if (Date.now() - cached.fetchedAt < TAG_CACHE_TTL_MS) {
          this.tagCache = cached;
          return cached;
        }
        try {
          var refreshed = await this.fetchTagList();
          this.tagCache = refreshed;
          return refreshed;
        } catch (e) {
          this.tagCache = cached;
          return cached;
        }
      }
      try {
        var fresh = await this.fetchTagList();
        this.tagCache = fresh;
        return fresh;
      } catch (e) {
        var synthetic = { tags: this.syntheticContentRatingTags(), fetchedAt: 0 };
        this.tagCache = synthetic;
        return synthetic;
      }
    };

    // 0.9: $a() / Ra() — API tag groups plus the 0.8 adaptations of the 0.9
    // advanced-search multi-selects (encoded as prefixed tag ids).
    MangaDex.prototype.getSearchTags = async function () {
      var ratings = this.getRatings();
      var cache;
      try { cache = await this.getTagList(); } catch (e) { cache = { tags: this.syntheticContentRatingTags(), fetchedAt: 0 }; }
      var groups = {};
      var groupOrder = [];
      for (var i = 0; i < cache.tags.length; i++) {
        var tag = cache.tags[i];
        var group = tag.group || "tags";
        if (!groups[group]) { groups[group] = { id: group, title: groupTitle(group), tags: [] }; groupOrder.push(group); }
        var ratingEnum = CONTENT_RATING_BY_ID[tag.id];
        var blocked = group === "content_rating" && (!ratingEnum || ratings.indexOf(ratingEnum) < 0);
        var label = (tag.name && tag.name.en ? tag.name.en : "Unknown") + (blocked ? " (Blocked in settings)" : "");
        groups[group].tags.push(App.createTag({ id: tag.id, label: label }));
      }
      var sections = groupOrder.map(function (group) {
        var section = groups[group];
        if (group !== "content_rating") {
          section.tags.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
        }
        return App.createTagSection({ id: section.id, label: section.title, tags: section.tags });
      });
      sections.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
      // 0.8 adaptations of the 0.9 advanced search form:
      sections.push(App.createTagSection({
        id: "publication_demographic",
        label: "Publication Demographic",
        tags: DEMOGRAPHICS.map(function (d) { return App.createTag({ id: "demo-" + d.enum, label: d.name }); }),
      }));
      sections.push(App.createTagSection({
        id: "publication_status",
        label: "Publication Status",
        tags: STATUSES.filter(function (s) { return s.searchable; }).map(function (s) {
          return App.createTag({ id: "status-" + s.enum, label: s.name });
        }),
      }));
      sections.push(App.createTagSection({
        id: "original_language",
        label: "Original Language",
        tags: ORIGINAL_LANGUAGES.map(function (l) { return App.createTag({ id: "lang-" + l.enum, label: l.name }); }),
      }));
      sections.push(App.createTagSection({
        id: "sort_order",
        label: "Sort Order",
        tags: SORT_OPTIONS.map(function (o) { return App.createTag({ id: o.id, label: o.label }); }),
      }));
      sections.push(App.createTagSection({
        id: "include_operator",
        label: "Include Tags Mode",
        tags: [
          App.createTag({ id: "incop-AND", label: "AND (all included tags)" }),
          App.createTag({ id: "incop-OR", label: "OR (any included tag)" }),
        ],
      }));
      sections.push(App.createTagSection({
        id: "exclude_operator",
        label: "Exclude Tags Mode",
        tags: [
          App.createTag({ id: "excop-OR", label: "OR (any excluded tag)" }),
          App.createTag({ id: "excop-AND", label: "AND (all excluded tags)" }),
        ],
      }));
      return sections;
    };

    // ---- search ----
    // 0.9: Sa() — parse mangadex.org URLs / "prefix: id" / raw ids in the title box.
    MangaDex.prototype.parseSearchQuery = function (text) {
      var value = text === null || text === undefined ? "" : String(text).trim();
      if (!value) { return null; }
      var match = value.match(URL_QUERY_REGEX);
      if (match) { return { prefix: PREFIX_MAP[match[1].toLowerCase()], uuid: match[2].toLowerCase() }; }
      match = value.match(PREFIX_QUERY_REGEX);
      if (match) { return { prefix: match[1].toLowerCase(), uuid: match[2].toLowerCase() }; }
      return null;
    };

    // 0.9: Ka() — map the 0.8 flat tag selections back to 0.9 search parameters.
    MangaDex.prototype.parseTagSelection = function (includedTags, excludedTags, tagGroupById) {
      var ratings = this.getRatings();
      var out = {
        ratings: ratings,
        includedTags: [],
        excludedTags: [],
        demographics: [],
        statuses: [],
        originalLanguages: [],
        orderKey: undefined,
        orderValue: undefined,
        includeOperator: undefined,
        excludeOperator: undefined,
      };
      var self = this;
      function applyTag(tag, mode) {
        var id = tag && tag.id ? String(tag.id) : "";
        if (!id) { return; }
        if (id.indexOf("order[") === 0) {
          if (mode === "included") {
            var dash = id.lastIndexOf("-");
            if (dash > 0) {
              var key = id.substring(0, dash);
              var value = id.substring(dash + 1);
              if (value === "asc" || value === "desc") { out.orderKey = key; out.orderValue = value; }
            }
          }
          return;
        }
        if (id.indexOf("demo-") === 0) { if (mode === "included") { out.demographics.push(id.slice(5)); } return; }
        if (id.indexOf("status-") === 0) { if (mode === "included") { out.statuses.push(id.slice(7)); } return; }
        if (id.indexOf("lang-") === 0) { if (mode === "included") { out.originalLanguages.push(id.slice(5)); } return; }
        if (id.indexOf("incop-") === 0) { out.includeOperator = id.slice(6).toUpperCase(); return; }
        if (id.indexOf("excop-") === 0) { out.excludeOperator = id.slice(6).toUpperCase(); return; }
        var ratingEnum = CONTENT_RATING_BY_ID[id];
        if (ratingEnum) {
          var index = out.ratings.indexOf(ratingEnum);
          if (mode === "included") {
            if (index < 0) { out.ratings.push(ratingEnum); }
          } else if (index >= 0) {
            out.ratings.splice(index, 1);
          }
          return;
        }
        if (mode === "included") { out.includedTags.push(id); } else { out.excludedTags.push(id); }
      }
      for (var i = 0; i < (includedTags || []).length; i++) { applyTag(includedTags[i], "included"); }
      for (var j = 0; j < (excludedTags || []).length; j++) { applyTag(excludedTags[j], "excluded"); }
      // canonical rating order (0.9: rn() order)
      out.ratings = RATINGS.map(function (r) { return r.enum; }).filter(function (r) { return out.ratings.indexOf(r) >= 0; });
      return out;
    };

    // 0.9: qa()
    MangaDex.prototype.resolveOrder = function (orderKey, orderValue, hasTitle) {
      if (orderKey && (orderValue === "asc" || orderValue === "desc") && !(orderKey === "order[relevance]" && !hasTitle)) {
        return { orderKey: orderKey, orderValue: orderValue };
      }
      return hasTitle ? { orderKey: "order[relevance]", orderValue: "desc" } : {};
    };

    // 0.9: Wa()
    MangaDex.prototype.expandLanguageCodes = function (codes) {
      if (!codes || codes.length === 0) { return []; }
      var out = [];
      for (var i = 0; i < codes.length; i++) {
        out.push(codes[i]);
        for (var j = 0; j < ORIGINAL_LANGUAGES.length; j++) {
          if (ORIGINAL_LANGUAGES[j].enum === codes[i] && ORIGINAL_LANGUAGES[j].extraCodes) {
            for (var k = 0; k < ORIGINAL_LANGUAGES[j].extraCodes.length; k++) { out.push(ORIGINAL_LANGUAGES[j].extraCodes[k]); }
          }
        }
      }
      return out;
    };

    // 0.9: gt()
    MangaDex.prototype.nextPageMetadata = function (offset, count, total, limit) {
      if (count < limit) { return undefined; }
      if (typeof total === "number" && offset + count >= total) { return undefined; }
      var next = offset + limit;
      if (next >= 10000) { return undefined; }
      return { offset: next };
    };

    // 0.9: to()
    MangaDex.prototype.getSearchResults = async function (query, metadata) {
      var languages = this.getLanguages();
      var offset = metadata && metadata.offset ? metadata.offset : 0;
      var included = query.includedTags || [];
      var excluded = query.excludedTags || [];
      var tagGroups = {};
      if (included.length > 0 || excluded.length > 0) {
        try {
          var cache = await this.getTagList();
          for (var t = 0; t < cache.tags.length; t++) { tagGroups[cache.tags[t].id] = cache.tags[t].group; }
        } catch (e) { tagGroups = {}; }
      }
      var selection = this.parseTagSelection(included, excluded, tagGroups);
      var empty = App.createPagedResults({ results: [], metadata: undefined });
      if (selection.ratings.length === 0) { return empty; }
      var parsed = this.parseSearchQuery(query.title);
      if (parsed && parsed.prefix === "usr") {
        return await this.searchUserChapters(parsed.uuid, metadata, selection.ratings, languages);
      }
      if (parsed && parsed.prefix === "list") {
        return await this.searchList(parsed.uuid, metadata, selection.ratings, languages);
      }
      var ids;
      var title;
      if (parsed && parsed.prefix === "id") {
        try { ids = [await this.resolveMangaId(parsed.uuid)]; } catch (e) { return empty; }
      } else if (parsed && parsed.prefix === "ch") {
        try {
          var chapterId = await this.resolveChapterId(parsed.uuid);
          var mangaId = await this.chapterMangaId(chapterId);
          if (!mangaId) { return empty; }
          ids = [mangaId];
        } catch (e) { return empty; }
      } else if (!parsed) {
        var rawTitle = String(query.title || "").trim();
        var uuidMatch = rawTitle.match(UUID_ANYWHERE_REGEX);
        if (uuidMatch) { ids = [uuidMatch[0].toLowerCase()]; }
        else { title = rawTitle || undefined; }
      }
      var order = this.resolveOrder(selection.orderKey, selection.orderValue, !!title);
      var hasIds = !!ids;
      var url = mangaListUrl({
        limit: 100,
        offset: offset,
        ratings: selection.ratings,
        languages: languages,
        hasAvailableChapters: hasIds ? undefined : true,
        orderKey: order.orderKey,
        orderValue: order.orderValue,
        demographics: hasIds ? [] : selection.demographics,
        statuses: hasIds ? [] : selection.statuses,
        originalLanguages: hasIds ? [] : this.expandLanguageCodes(selection.originalLanguages),
        authorOrArtist: parsed && parsed.prefix === "author" ? parsed.uuid : undefined,
        group: parsed && parsed.prefix === "grp" ? parsed.uuid : undefined,
        ids: ids,
        title: title,
      });
      if (!hasIds) {
        if (selection.includeOperator) { url.setQueryItem("includedTagsMode", selection.includeOperator); }
        if (selection.excludeOperator) { url.setQueryItem("excludedTagsMode", selection.excludeOperator); }
        if (selection.includedTags.length > 0) { url.setQueryItem("includedTags[]", selection.includedTags); }
        if (selection.excludedTags.length > 0) { url.setQueryItem("excludedTags[]", selection.excludedTags); }
      }
      var body = await this.apiGet(url.toString());
      if (!Array.isArray(body.data)) { return empty; }
      var relevanceTitle = (title && (!order.orderKey || order.orderKey === "order[relevance]")) ? title : undefined;
      var results = await this.mapSearchResults(body.data, selection.ratings, languages, relevanceTitle);
      return App.createPagedResults({
        results: results,
        metadata: this.nextPageMetadata(offset, body.data.length, body.total, 100),
      });
    };

    // 0.9: Xa()
    MangaDex.prototype.chapterMangaId = async function (chapterId) {
      try {
        var body = await this.apiGet(chapterByIdUrl(chapterId, ["manga"]).toString());
        return mangaIdFromRelationships(body.data ? body.data.relationships : undefined);
      } catch (e) { return undefined; }
    };

    // 0.9: Ya()
    MangaDex.prototype.mangaPartialsByIds = async function (ids, ratings, languages) {
      if (!ids || ids.length === 0) { return []; }
      var body = await this.apiGet(mangaListUrl({ limit: ids.length, ratings: ratings, languages: languages, ids: ids }).toString());
      if (!Array.isArray(body.data)) { return []; }
      var byId = {};
      for (var i = 0; i < body.data.length; i++) { byId[body.data[i].id] = body.data[i]; }
      var out = [];
      for (var j = 0; j < ids.length; j++) {
        var item = byId[ids[j]];
        if (item) { out.push(item); }
      }
      return out;
    };

    // 0.9: Za()
    MangaDex.prototype.searchUserChapters = async function (userId, metadata, ratings, languages) {
      var offset = metadata && metadata.offset ? metadata.offset : 0;
      for (var attempt = 0; attempt < 3; attempt++) {
        var body = await this.apiGet(chapterListUrl({
          limit: 100,
          offset: offset,
          languages: languages,
          ratings: ratings,
          uploaders: [userId],
          includes: ["manga"],
        }).toString());
        if (!Array.isArray(body.data)) { return App.createPagedResults({ results: [], metadata: undefined }); }
        var next = this.nextPageMetadata(offset, body.data.length, body.total, 100);
        if (body.data.length === 0) { return App.createPagedResults({ results: [], metadata: next }); }
        var seen = {};
        var ids = [];
        for (var i = 0; i < body.data.length; i++) {
          var mangaId = mangaIdFromRelationships(body.data[i].relationships);
          if (!mangaId || seen[mangaId]) { continue; }
          seen[mangaId] = true;
          ids.push(mangaId);
        }
        var items = await this.mangaPartialsByIds(ids, ratings, languages);
        var partials = await this.mapSearchResults(items, ratings, languages, undefined);
        if (partials.length > 0 || next === undefined) {
          return App.createPagedResults({ results: partials, metadata: next });
        }
        offset = next.offset;
      }
      return App.createPagedResults({ results: [], metadata: { offset: offset } });
    };

    // 0.9: Qa()
    MangaDex.prototype.searchList = async function (listId, metadata, ratings, languages) {
      var offset = metadata && metadata.offset ? metadata.offset : 0;
      var listMangaIds = metadata && metadata.listMangaIds ? metadata.listMangaIds : undefined;
      if (!listMangaIds) {
        var listBody = await this.apiGet(listUrl(listId));
        if (!listBody.data || !Array.isArray(listBody.data.relationships)) {
          return App.createPagedResults({ results: [], metadata: undefined });
        }
        listMangaIds = listBody.data.relationships.filter(function (r) { return r && r.type === "manga"; }).map(function (r) { return r.id; });
      }
      if (listMangaIds.length === 0) { return App.createPagedResults({ results: [], metadata: undefined }); }
      for (var attempt = 0; attempt < 3; attempt++) {
        var chunkIds = listMangaIds.slice(offset, offset + 100);
        if (chunkIds.length === 0) { return App.createPagedResults({ results: [], metadata: undefined }); }
        var nextOffset = offset + chunkIds.length;
        var next = nextOffset < listMangaIds.length ? { offset: nextOffset, listMangaIds: listMangaIds } : undefined;
        var items = await this.mangaPartialsByIds(chunkIds, ratings, languages);
        var partials = await this.mapSearchResults(items, ratings, languages, undefined);
        if (partials.length > 0 || next === undefined) {
          return App.createPagedResults({ results: partials, metadata: next });
        }
        offset = nextOffset;
      }
      return App.createPagedResults({ results: [], metadata: { offset: offset, listMangaIds: listMangaIds } });
    };

    // ---- home page / discover sections (0.9: oa / sa) ----
    // 0.9: It/Rt/Bt/Ht/Wt/Kt section toggles — all default to enabled in 0.8.
    MangaDex.prototype.getEnabledHomeSections = function () {
      return HOME_SECTIONS.slice();
    };

    // 0.8 home section type mapping for the 0.9 discover section types.
    function mapHomeSectionType(type) {
      switch (type) {
        case "prominentCarousel": return "featured";
        case "chapterUpdates": return "singleRowLarge";
        case "featured": return "featured";
        case "simpleCarousel": return "singleRowNormal";
        default: return "singleRowNormal";
      }
    }

    MangaDex.prototype.getHomePageSections = async function (sectionCallback) {
      var sections = this.getEnabledHomeSections();
      var failed = 0;
      var lastError = null;
      for (var i = 0; i < sections.length; i++) {
        var def = sections[i];
        try {
          var result = await this.fetchDiscoverSectionItems(def, undefined);
          var section = App.createHomeSection({
            id: def.id,
            title: def.title,
            type: mapHomeSectionType(def.type),
            containsMoreItems: def.containsMoreItems,
          });
          section.items = result.items;
          sectionCallback(section);
        } catch (e) {
          failed++;
          lastError = e;
        }
      }
      if (failed === sections.length && sections.length > 0) {
        throw new Error("Could not load the MangaDex home page: " + (lastError && lastError.message ? lastError.message : "network error"));
      }
    };

    // 0.8 view-more for sections that expose pagination metadata (0.9: sa()).
    MangaDex.prototype.getViewMoreItems = async function (homepageSectionId, metadata) {
      var sections = this.getEnabledHomeSections();
      var def = null;
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].id === homepageSectionId) { def = sections[i]; break; }
      }
      if (!def || !def.containsMoreItems) {
        return App.createPagedResults({ results: [], metadata: undefined });
      }
      var result = await this.fetchDiscoverSectionItems(def, metadata);
      return App.createPagedResults({ results: result.items, metadata: result.metadata });
    };

    // 0.9: sa()
    MangaDex.prototype.fetchDiscoverSectionItems = async function (def, metadata) {
      switch (def.id) {
        case "popular":
          return await this.discoverByOrder("order[followedCount]", metadata, startOfUtcDayIso(Date.now() - 2592e6));
        case "recently_added":
          return await this.discoverByOrder("order[createdAt]", metadata, undefined);
        case "latest_updates":
          return await this.discoverLatestUpdates(def, metadata);
        case "recommended":
          return await this.discoverCurated(def, "recommended", metadata);
        case "self_published":
          return await this.discoverCurated(def, "selfPublished", metadata);
        case "seasonal":
          return await this.discoverCurated(def, "seasonal", metadata);
        default:
          return { items: [], metadata: undefined };
      }
    };

    // 0.9: da()/pa()/ua()
    MangaDex.prototype.discoverByOrder = async function (orderKey, metadata, createdAtSince) {
      var offset = metadata && metadata.offset ? metadata.offset : 0;
      var url = mangaListUrl({
        limit: 100,
        offset: offset,
        ratings: this.getRatings(),
        languages: this.getLanguages(),
        hasAvailableChapters: true,
        orderKey: orderKey,
        orderValue: "desc",
        createdAtSince: createdAtSince,
      });
      var body = await this.apiGet(url.toString());
      this.validateCollection(body, orderKey);
      var items = [];
      for (var i = 0; i < body.data.length; i++) {
        if (!body.data[i] || !body.data[i].attributes) { continue; }
        items.push(this.partialFromMangaItem(body.data[i], { thumbnailKind: "discover" }));
      }
      return { items: items, metadata: this.nextPageMetadata(offset, body.data.length, body.total, 100) };
    };

    // 0.9: fa() — latest chapter uploads, one entry per manga.
    MangaDex.prototype.discoverLatestUpdates = async function (def, metadata) {
      var offset = metadata && metadata.offset ? metadata.offset : 0;
      var ratings = this.getRatings();
      var languages = this.getLanguages();
      var body = await this.apiGet(chapterListUrl({
        limit: 100,
        offset: offset,
        languages: languages,
        ratings: ratings,
        excludedUploaders: SETTINGS.blocked_uploaders,
      }).toString());
      this.validateCollection(body, def.title);
      var next = this.nextPageMetadata(offset, body.data.length, body.total, 100);
      var firstChapterByManga = {};
      var ids = [];
      for (var i = 0; i < body.data.length; i++) {
        var chapter = body.data[i];
        if (!chapter) { continue; }
        var mangaId = mangaIdFromRelationships(chapter.relationships);
        if (!mangaId || firstChapterByManga[mangaId]) { continue; }
        firstChapterByManga[mangaId] = chapter;
        ids.push(mangaId);
      }
      if (ids.length === 0) { return { items: [], metadata: next }; }
      var mangaBody = await this.apiGet(mangaListUrl({
        limit: ids.length,
        ratings: ratings,
        languages: languages,
        ids: ids,
      }).toString());
      this.validateCollection(mangaBody, def.title);
      var byId = {};
      for (var m = 0; m < mangaBody.data.length; m++) { byId[mangaBody.data[m].id] = mangaBody.data[m]; }
      var items = [];
      for (var k = 0; k < ids.length; k++) {
        var manga = byId[ids[k]];
        var latestChapter = firstChapterByManga[ids[k]];
        if (!manga || !manga.attributes) { continue; }
        items.push(this.partialFromMangaItem(manga, {
          thumbnailKind: "discover",
          chapterAttributes: latestChapter.attributes,
        }));
      }
      return { items: items, metadata: next };
    };

    // ---- curated lists (0.9: ra / ta / ea / Zi / Ki / Qi / Xi / Yi) ----
    MangaDex.prototype.isValidCuratedCache = function (cache) {
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) { return false; }
      if (typeof cache.fetchedAt !== "number" || !cache.ids || typeof cache.ids !== "object" || Array.isArray(cache.ids)) { return false; }
      return isUuid(cache.ids.seasonal) && isUuid(cache.ids.recommended) && isUuid(cache.ids.selfPublished);
    };
    MangaDex.prototype.mergeCuratedFallbacks = function (ids) {
      return {
        seasonal: (ids && ids.seasonal) || CURATED_FALLBACKS.seasonal,
        recommended: (ids && ids.recommended) || CURATED_FALLBACKS.recommended,
        selfPublished: (ids && ids.selfPublished) || CURATED_FALLBACKS.selfPublished,
      };
    };
    MangaDex.prototype.refreshCuratedListIds = async function () {
      var body = await this.apiGet(userListUrl(CURATED_USER_ID, 100).toString());
      var data = Array.isArray(body.data) ? body.data : [];
      var now = new Date();
      var currentScore = now.getUTCFullYear() * 4 + SEASON_INDEX[this.currentSeason(now)];
      var recommended;
      var selfPublished;
      var seasonal;
      var seasonalScore = -1;
      var seasonalCount = 0;
      for (var i = 0; i < data.length; i++) {
        var list = data[i];
        if (!list || !list.attributes || list.attributes.visibility !== "public") { continue; }
        var name = list.attributes.name || "";
        if (!name) { continue; }
        var count = (list.relationships || []).filter(function (r) { return r && r.type === "manga"; }).length;
        if (count === 0) { continue; }
        var normalized = name.trim().toLowerCase().replace(/[-_\s]+/g, "");
        if (!recommended && normalized === "recommended") { recommended = list.id; continue; }
        if (!selfPublished && normalized === "selfpublished") { selfPublished = list.id; continue; }
        var season = this.parseSeasonalName(name);
        if (!season) { continue; }
        var score = season.year * 4 + SEASON_INDEX[season.season];
        if (score > currentScore) { continue; }
        if (!seasonal || score > seasonalScore || (score === seasonalScore && count > seasonalCount)) {
          seasonal = list.id;
          seasonalScore = score;
          seasonalCount = count;
        }
      }
      var ids = { seasonal: seasonal, recommended: recommended, selfPublished: selfPublished };
      try {
        await this.stateManager.store(CURATED_CACHE_KEY, JSON.stringify({ ids: ids, fetchedAt: Date.now() }));
      } catch (e) { /* ignore */ }
      return ids;
    };
    MangaDex.prototype.currentSeason = function (date) {
      var month = date.getUTCMonth() + 1;
      if (month <= 3) { return "winter"; }
      if (month <= 6) { return "spring"; }
      if (month <= 9) { return "summer"; }
      return "fall";
    };
    MangaDex.prototype.parseSeasonalName = function (name) {
      var match = String(name).match(/^Seasonal:\s+(Winter|Spring|Summer|Fall)\s+(\d{4})\b/i);
      if (!match) { return null; }
      return { season: match[1].toLowerCase(), year: parseInt(match[2], 10) };
    };
    MangaDex.prototype.getCuratedListIds = async function () {
      var cached = null;
      try {
        var raw = await this.stateManager.retrieve(CURATED_CACHE_KEY);
        cached = raw ? JSON.parse(raw) : null;
      } catch (e) { cached = null; }
      if (this.isValidCuratedCache(cached)) {
        if (Date.now() - cached.fetchedAt >= CURATED_CACHE_TTL_MS) {
          this.refreshCuratedListIds().catch(function () { /* keep stale cache */ });
        }
        return this.mergeCuratedFallbacks(cached.ids);
      }
      try {
        return this.mergeCuratedFallbacks(await this.refreshCuratedListIds());
      } catch (e) {
        return this.mergeCuratedFallbacks(undefined);
      }
    };

    // 0.9: la() + ca() + na()
    MangaDex.prototype.discoverCurated = async function (def, key, metadata) {
      var ratings = this.getRatings();
      var languages = this.getLanguages();
      var listIds = await this.getCuratedListIds();
      var listId = listIds[key];
      if (!listId) { return { items: [], metadata: undefined }; }
      var listBody = await this.apiGet(listUrl(listId));
      if (!listBody.data || !Array.isArray(listBody.data.relationships)) {
        throw new Error("MangaDex returned no list data for " + listId);
      }
      var mangaIds = listBody.data.relationships.filter(function (r) { return r && r.type === "manga"; }).map(function (r) { return r.id; });
      if (mangaIds.length === 0) { return { items: [], metadata: undefined }; }
      var chunks = chunk(mangaIds, 100);
      var allItems = [];
      var failures = 0;
      for (var i = 0; i < chunks.length; i++) {
        try {
          var body = await this.apiGet(mangaListUrl({
            limit: chunks[i].length,
            ratings: ratings,
            languages: languages,
            ids: chunks[i],
          }).toString());
          if (Array.isArray(body.data)) { allItems = allItems.concat(body.data); }
        } catch (e) { failures++; }
      }
      if (allItems.length === 0) {
        if (failures === chunks.length) {
          throw new Error("Failed to create results for " + def.title + ", check MangaDex status");
        }
        return { items: [], metadata: undefined };
      }
      var byId = {};
      for (var m = 0; m < allItems.length; m++) { byId[allItems[m].id] = allItems[m]; }
      var ordered = [];
      for (var k = 0; k < mangaIds.length; k++) {
        var item = byId[mangaIds[k]];
        if (item && item.attributes) { ordered.push(item); }
      }
      var items = [];
      for (var j = 0; j < ordered.length; j++) {
        items.push(this.partialFromMangaItem(ordered[j], { thumbnailKind: "discover" }));
      }
      return { items: items, metadata: undefined };
    };

    // 0.8 sources may check this before offering tag exclusion in search.
    MangaDex.prototype.supportsTagExclusion = function () {
      return true;
    };

    return MangaDex;
  })();

  return { MangaDex: MangaDex, MangaDexInfo: MangaDexInfo };
});
