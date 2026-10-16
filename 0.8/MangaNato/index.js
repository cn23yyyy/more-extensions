// ============================================================================
// MangaNato (manganato.gg) — Paperback 0.8 extension
// Converted from the Aidoku "MangaNato" source (0.9, extension 1.0.0-alpha.11).
//
// The 0.9 source is a static HTML scraper. Endpoints:
//   - manga details:  GET /manga/{mangaId}
//   - chapter list:   GET /api/manga/{mangaId}/chapters?limit=9000&offset=0 (JSON)
//   - chapter images: GET /manga/{mangaId}/{chapterId}
//   - discover lists: GET /manga-list/{new,latest,hot,completed}-manga?page=N
//   - search:         GET /search/story/{query}?page=N or /genre/{genre}?page=N
//   - genres:         parsed from the home page "GENRES" panel
//
// manganato.gg serves /search/story through a Cloudflare challenge on some
// networks; the extension declares CLOUDFLARE_BYPASS_REQUIRED and sends the
// bypass request to /search/story (the 0.9 source's bypassPage).
//
// All selectors/parsing are ported from the 0.9 parser; only the plumbing
// (App.createRequest / requestManager.schedule / this.cheerio.load) is 0.8.
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

  var BASE_URL = "https://www.manganato.gg";
  var LANGUAGE = "en";
  var RETRY = 3;

  // 0.9 getDiscoverSections() + the 0.8 section types they map to.
  var HOME_SECTIONS = [
    { id: "new_titles", title: "New Titles", type: "featured", path: "/manga-list/new-manga" },
    { id: "latest_updates", title: "Latest Updates", type: "singleRowNormal", path: "/manga-list/latest-manga" },
    { id: "most_popular", title: "Most Popular", type: "singleRowNormal", path: "/manga-list/hot-manga" },
    { id: "completed_titles", title: "Completed Titles", type: "singleRowNormal", path: "/manga-list/completed-manga" },
  ];

  // 0.9 parser: these genre names flip the content rating to adult.
  var ADULT_GENRES = ["adult", "mature", "smut"];

  // ---------------------------------------------------------------------------
  // HTML entity decoding (0.9 used Application.decodeHTMLEntities)
  // ---------------------------------------------------------------------------
  var HTML_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", middot: "\u00b7",
    lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
    bull: "\u2022", dagger: "\u2020", Dagger: "\u2021", permil: "\u2030",
    copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0",
    plusmn: "\u00b1", times: "\u00d7", divide: "\u00f7", frac12: "\u00bd",
    frac14: "\u00bc", frac34: "\u00be", sup2: "\u00b2", sup3: "\u00b3",
    micro: "\u00b5", para: "\u00b6", sect: "\u00a7", iexcl: "\u00a1",
    iquest: "\u00bf", laquo: "\u00ab", raquo: "\u00bb", cent: "\u00a2",
    pound: "\u00a3", yen: "\u00a5", euro: "\u20ac", curren: "\u00a4",
    szlig: "\u00df", agrave: "\u00e0", aacute: "\u00e1", auml: "\u00e4",
    aring: "\u00e5", ccedil: "\u00e7", egrave: "\u00e8", eacute: "\u00e9",
    euml: "\u00eb", iuml: "\u00ef", ntilde: "\u00f1", ograve: "\u00f2",
    oacute: "\u00f3", ouml: "\u00f6", oslash: "\u00f8", ugrave: "\u00f9",
    uacute: "\u00fa", uuml: "\u00fc", alpha: "\u03b1", beta: "\u03b2",
    gamma: "\u03b3", delta: "\u03b4", epsilon: "\u03b5", pi: "\u03c0",
    sigma: "\u03c3", omega: "\u03c9",
  };

  function fromCodePoint(cp) {
    if (cp > 0xFFFF) {
      cp -= 0x10000;
      return String.fromCharCode(((cp >>> 10) & 0x3FF) | 0xD800, (cp & 0x3FF) | 0xDC00);
    }
    return String.fromCharCode(cp);
  }

  function decodeHTMLEntities(input) {
    if (input === undefined || input === null) { return ""; }
    return String(input)
      .replace(/&#x([0-9a-f]+);/gi, function (m, hex) { return fromCodePoint(parseInt(hex, 16)); })
      .replace(/&#([0-9]+);/g, function (m, dec) { return fromCodePoint(parseInt(dec, 10)); })
      .replace(/&([a-z][a-z0-9]*);/gi, function (m, name) {
        var v = HTML_ENTITIES[name.toLowerCase()];
        return v !== undefined ? v : m;
      });
  }

  function safeDecodeURI(s) {
    try { return decodeURI(s); } catch (e) { return s; }
  }

  function safeDate(s) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) { return d; }
    // "2026-10-16T01:53:39.000000Z" — some engines reject >3 fractional digits.
    d = new Date(String(s).replace(/(\.\d{3})\d+/, "$1"));
    return isNaN(d.getTime()) ? new Date() : d;
  }

  // ---------------------------------------------------------------------------
  // Extension info
  // ---------------------------------------------------------------------------
  var MangaNatoInfo = {
    version: "1.0.0",
    name: "MangaNato",
    description: "Extension that pulls content from manganato.gg. Converted from the Aidoku MangaNato source.",
    author: "converted",
    authorWebsite: "",
    icon: "icon.png",
    contentRating: "EVERYONE",
    websiteBaseURL: BASE_URL,
    sourceTags: [{ text: "English", type: "info" }],
    // MANGA_CHAPTERS | HOMEPAGE_SECTIONS | CLOUDFLARE_BYPASS_REQUIRED
    intents: 1 | 4 | 16,
  };

  // ---------------------------------------------------------------------------
  // Source
  // ---------------------------------------------------------------------------
  var MangaNato = (function () {
    function MangaNato(cheerio) {
      this.cheerio = cheerio;
      this.baseUrl = BASE_URL;
      this.requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 20000,
        interceptor: {
          interceptRequest: async (request) => {
            var headers = {};
            var src = request.headers || {};
            for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) { headers[k] = src[k]; } }
            headers["user-agent"] = await this.requestManager.getDefaultUserAgent();
            var url = String(request.url || "");
            // Only manganato.gg itself gets a referer. The image CDN
            // (img-r1.2xstorage.com) is a different host; the 0.9 source never
            // sent it a referer, so strip any inherited one.
            if (/^https?:\/\/(www\.)?manganato\.gg([/?#]|$)/i.test(url)) {
              headers["referer"] = this.baseUrl + "/";
            } else {
              delete headers["referer"];
              delete headers["Referer"];
              delete headers["origin"];
              delete headers["Origin"];
            }
            request.headers = headers;
            return request;
          },
          interceptResponse: async (response) => response,
        },
      });
    }

    // ---- low level (0.8 plumbing) ----
    MangaNato.prototype.checkResponseError = function (response) {
      var status = response.status;
      if (status === 403 || status === 503) {
        throw new Error("CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <" + this.baseUrl + "> and press the cloud icon.");
      }
      if (status === 404) {
        throw new Error("The requested page was not found (" + (response.request ? response.request.url : "") + ")");
      }
      if (status < 200 || status >= 300) {
        throw new Error("HTTP " + status + " from manganato.gg");
      }
    };

    MangaNato.prototype.getHtml = async function (url) {
      var request = App.createRequest({ url: url, method: "GET" });
      var response = await this.requestManager.schedule(request, RETRY);
      this.checkResponseError(response);
      return this.cheerio.load(response.data);
    };

    MangaNato.prototype.getJson = async function (url) {
      var request = App.createRequest({ url: url, method: "GET", headers: { "Accept": "application/json, text/plain, */*" } });
      var response = await this.requestManager.schedule(request, RETRY);
      this.checkResponseError(response);
      return response.data;
    };

    // ---- parsing helpers (ported from the 0.9 parser) ----
    MangaNato.prototype.isLastPage = function ($) {
      var current = $(".page-select, .page_select").text();
      var last = $(".page-last, .page_last").text();
      if (!current) { return true; }
      var m = /(\d+)/g.exec(last);
      var lastNum = m ? m[0] : "";
      return +lastNum === +current;
    };

    // 0.9 idCleaner: strip a trailing slash, keep the last path segment.
    MangaNato.prototype.idCleaner = function (href) {
      var t = String(href || "").replace(/\/$/, "");
      t = t.split("/").pop() || "";
      if (!t) { throw new Error("Unable to parse id for " + href); }
      return t;
    };

    // 0.9 getImageSrc: first non-empty of data-src, data-lazy-src, srcset, src,
    // data-cfsrc; srcset takes its first entry; protocol fixes; decode.
    MangaNato.prototype.getImageSrc = function ($img) {
      var src = null;
      var attrs = ["data-src", "data-lazy-src", "srcset", "src", "data-cfsrc"];
      for (var i = 0; i < attrs.length; i++) {
        var raw = $img.attr(attrs[i]);
        if (raw === undefined || raw === null || String(raw).trim() === "") { continue; }
        if (attrs[i] === "srcset") {
          var first = String(raw).split(",")[0];
          first = first ? first.trim().split(" ")[0] : "";
          src = first || "";
        } else {
          src = String(raw);
        }
        break;
      }
      if (src === null) { return ""; }
      if (src.charAt(0) === "/") { src = this.baseUrl + src; }
      src = src.trim().replace(/(\s{2,})/gi, "");
      src = src.replace(/http:\/\/\//g, "http://").replace(/http:\/\//g, "https://").replace(/https:\/\/\//g, "https://");
      return safeDecodeURI(decodeHTMLEntities(src));
    };

    MangaNato.prototype.decodeHTMLEntities = function (s) {
      return decodeHTMLEntities(s);
    };

    MangaNato.prototype.parseMangaDetails = function ($, mangaId) {
      var root = "div.main-wrapper";

      var primaryTitle = $("img", root).attr("alt");
      primaryTitle = primaryTitle ? primaryTitle.trim() : "";

      var imageSrc = this.getImageSrc($("img", root));
      var image = imageSrc ? encodeURI(imageSrc) : "";

      var altText = $(".story-alternative", root).first().text().trim().replace(/^Alternative\s*:\s*/i, "");
      var secondaryTitles = altText.split(";").map(function (t) { return t.trim(); }).filter(function (t) { return t.length > 0; });

      var author = $('.info-wrap > div:contains("Author(s):")').first().clone().children("p").remove().end().text().trim();

      var synopsis = $("#contentBox", root).first().text();
      synopsis = synopsis.replace(/You are reading.*bookmark\./i, "");
      synopsis = synopsis.replace(/<[^>]*>?/gm, "");
      synopsis = decodeHTMLEntities(synopsis.replace(/\s{2,}/g, " ").trim());

      var shareUrl = this.baseUrl + "/manga/" + mangaId;

      // 0.9: text of #rate_row_cmd, "rate : X" out of 10 -> X/10*2 (0-5 scale).
      // The live site currently renders "0.00 / 5 - N votes", so also accept a
      // direct X / 5 score when the "rate :" pattern is absent.
      var rateText = $("#rate_row_cmd").text().trim();
      var rateMatch = /rate\s*:\s*([\d.]+)/.exec(rateText);
      var rating = 0;
      if (rateMatch) {
        rating = (Number(rateMatch[1]) || 0) / 10 * 2;
      } else {
        var direct = /([\d.]+)\s*\/\s*5/.exec(rateText);
        if (direct) { rating = Number(direct[1]) || 0; }
      }

      var statusText = $("li:contains(Status)", root).text().trim().toUpperCase();
      var status = statusText.indexOf("COMPLETED") >= 0 ? "Completed" : "Ongoing";

      var contentRating = "EVERYONE";
      var genres = [];
      var anchors = $("a", $("li.genres", root)).toArray();
      for (var i = 0; i < anchors.length; i++) {
        var name = $(anchors[i]).text().trim();
        var href = $(anchors[i]).attr("href") || "";
        var id = null;
        try { id = this.idCleaner(href); } catch (e) { id = null; }
        if (!name || !id) { continue; }
        if (ADULT_GENRES.indexOf(name.toLowerCase()) >= 0) { contentRating = "ADULT"; }
        genres.push({ title: name, id: id });
      }

      var tagSection = App.createTagSection({
        id: "genres",
        label: "Genres",
        tags: genres.map(function (g) { return App.createTag({ id: g.id, label: g.title }); }),
      });

      return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
          titles: [primaryTitle].concat(secondaryTitles),
          image: image,
          rating: rating,
          status: status,
          desc: synopsis,
          author: author,
          artist: "",
          hentai: contentRating !== "EVERYONE",
          tags: [tagSection],
        }),
      });
    };

    MangaNato.prototype.parseChapterList = function (json, mangaId) {
      var chapters = [];
      if (json && json.success && json.data && Array.isArray(json.data.chapters)) {
        var items = json.data.chapters;
        for (var i = 0; i < items.length; i++) {
          var c = items[i];
          chapters.push(App.createChapter({
            id: c.chapter_slug,
            name: c.chapter_name,
            chapNum: Number(c.chapter_num) || 0,
            time: safeDate(c.updated_at),
            langCode: LANGUAGE,
            sortingIndex: items.length - i,
          }));
        }
      } else {
        console.log("Invalid JSON structure for manga " + mangaId);
      }
      return chapters;
    };

    MangaNato.prototype.parseChapterDetails = function ($, mangaId, chapterId) {
      var pages = [];
      var imgs = $("img", "div.container-chapter-reader").toArray();
      for (var i = 0; i < imgs.length; i++) {
        var src = this.getImageSrc($(imgs[i]));
        if (!src) {
          console.log("Could not parse pages for mangaId:" + mangaId + " chapterId:" + chapterId);
          continue;
        }
        pages.push(encodeURI(src));
      }
      return App.createChapterDetails({
        id: chapterId,
        mangaId: mangaId,
        pages: pages,
      });
    };

    // 0.9 parseDiscoverSections; the section type only changes which field the
    // chapter text lands in, so every 0.8 item is a partial manga with subtitle.
    MangaNato.prototype.parseDiscoverSections = function ($) {
      var results = [];
      var items = $("div.list-comic-item-wrap").toArray();
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var imageSrc = this.getImageSrc($("img", item));
        var image = imageSrc ? encodeURI(imageSrc) : "";
        var alt = $("img", item).attr("alt");
        var title = alt ? alt.trim() : "";
        var mangaId = null;
        try { mangaId = this.idCleaner($("a", item).attr("href") || ""); } catch (e) { mangaId = null; }
        var chapterText = $("a.list-story-item-wrap-chapter", item).first().text().trim();
        if (!mangaId || !title) { continue; }
        results.push(App.createPartialSourceManga({
          mangaId: mangaId,
          image: image,
          title: decodeHTMLEntities(title),
          subtitle: decodeHTMLEntities(chapterText),
        }));
      }
      return results;
    };

    MangaNato.prototype.parseSearchTags = function ($) {
      var tags = [];
      var parent = $('h3:contains("GENRES")').parent();
      var cells = $("td", parent).toArray();
      for (var i = 0; i < cells.length; i++) {
        var label = $("a", cells[i]).attr("title");
        label = label ? label.trim() : "";
        var href = $("a", cells[i]).attr("href") || "";
        var id = null;
        try { id = this.idCleaner(href); } catch (e) { id = null; }
        if (!id || !label) { continue; }
        tags.push({ title: label, id: id });
      }
      tags.sort(function (a, b) { return a.title.localeCompare(b.title); });
      return [App.createTagSection({
        id: "genres",
        label: "Genres",
        tags: tags.map(function (t) { return App.createTag({ id: t.id, label: t.title }); }),
      })];
    };

    MangaNato.prototype.parseSearchResults = function ($, hasTitle) {
      var results = [];
      if (hasTitle) {
        var items = $("div.story_item").toArray();
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var imageSrc = this.getImageSrc($("img", item));
          var image = imageSrc ? encodeURI(imageSrc) : "";
          var title = $(".story_name", item).text().trim();
          var mangaId = null;
          try { mangaId = this.idCleaner($("a", item).attr("href") || ""); } catch (e) { mangaId = null; }
          var chapterText = $(".story_chapter", item).first().text().trim();
          if (!mangaId || !title) { continue; }
          results.push(App.createPartialSourceManga({
            mangaId: mangaId,
            image: image,
            title: decodeHTMLEntities(title),
            subtitle: decodeHTMLEntities(chapterText),
          }));
        }
      } else {
        results = this.parseDiscoverSections($);
      }
      return results;
    };

    MangaNato.prototype.sanitizeQuery = function (q) {
      return String(q || "").replace(/'[^ ]*/g, "").replace(/\.+/g, "").replace(/["']/g, "").trim();
    };

    // ---- source interface ----
    MangaNato.prototype.getMangaShareUrl = function (mangaId) {
      return this.baseUrl + "/manga/" + mangaId;
    };

    MangaNato.prototype.getMangaDetails = async function (mangaId) {
      var $ = await this.getHtml(this.baseUrl + "/manga/" + mangaId);
      return this.parseMangaDetails($, mangaId);
    };

    MangaNato.prototype.getChapters = async function (mangaId) {
      var url = this.baseUrl + "/api/manga/" + mangaId + "/chapters?limit=9000&offset=0";
      var data = await this.getJson(url);
      var json;
      try {
        json = JSON.parse(String(data));
      } catch (e) {
        console.log("Failed to parse JSON for " + mangaId);
        return [];
      }
      return this.parseChapterList(json, mangaId);
    };

    MangaNato.prototype.getChapterDetails = async function (mangaId, chapterId) {
      var $ = await this.getHtml(this.baseUrl + "/manga/" + mangaId + "/" + chapterId);
      return this.parseChapterDetails($, mangaId, chapterId);
    };

    MangaNato.prototype.getSearchTags = async function () {
      var $ = await this.getHtml(this.baseUrl + "/");
      return this.parseSearchTags($);
    };

    MangaNato.prototype.getSearchResults = async function (query, metadata) {
      var page = metadata && metadata.page ? metadata.page : 1;
      var included = query.includedTags || [];
      var genreId = included.length ? included[0].id : null;

      var url;
      var hasTitle = false;
      if (query.title) {
        hasTitle = true;
        url = this.baseUrl + "/search/story/" + encodeURIComponent(this.sanitizeQuery(query.title)) + "?page=" + page;
      } else if (genreId) {
        url = this.baseUrl + "/genre/" + genreId + "?page=" + page;
      } else {
        url = this.baseUrl + "/manga-list/latest-manga?page=" + page;
      }

      var $ = await this.getHtml(url);
      var results = this.parseSearchResults($, hasTitle);
      var next = this.isLastPage($) ? undefined : { page: page + 1 };
      return App.createPagedResults({
        results: results,
        metadata: next,
      });
    };

    MangaNato.prototype.getHomePageSections = async function (sectionCallback) {
      var loaded = 0;
      var lastError = null;
      for (var i = 0; i < HOME_SECTIONS.length; i++) {
        var def = HOME_SECTIONS[i];
        try {
          var $ = await this.getHtml(this.baseUrl + def.path + "?page=1");
          var section = App.createHomeSection({
            id: def.id,
            title: def.title,
            type: def.type,
            containsMoreItems: true,
          });
          section.items = this.parseDiscoverSections($);
          loaded++;
          sectionCallback(section);
        } catch (e) {
          lastError = e;
        }
      }
      if (loaded === 0) {
        throw new Error("Could not load the manganato.gg home page: " + (lastError && lastError.message ? lastError.message : "network error"));
      }
    };

    MangaNato.prototype.getViewMoreItems = async function (homepageSectionId, metadata) {
      var page = metadata && metadata.page ? metadata.page : 1;
      var def = null;
      for (var i = 0; i < HOME_SECTIONS.length; i++) {
        if (HOME_SECTIONS[i].id === homepageSectionId) { def = HOME_SECTIONS[i]; break; }
      }
      if (!def) { throw new Error("Invalid sectionId provided!"); }

      var $ = await this.getHtml(this.baseUrl + def.path + "?page=" + page);
      var results = this.parseDiscoverSections($);
      var next = this.isLastPage($) ? undefined : { page: page + 1 };
      return App.createPagedResults({
        results: results,
        metadata: next,
      });
    };

    // The 0.9 bypassPage is https://www.manganato.gg/search/story
    MangaNato.prototype.getCloudflareBypassRequestAsync = async function () {
      return App.createRequest({
        url: this.baseUrl + "/search/story",
        method: "GET",
        headers: {
          "user-agent": await this.requestManager.getDefaultUserAgent(),
          "referer": this.baseUrl + "/",
        },
      });
    };

    return MangaNato;
  })();

  return { MangaNato: MangaNato, MangaNatoInfo: MangaNatoInfo };
});
