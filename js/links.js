/*
 * links.js - Buy List Finder link builder.
 *
 * The ONLY file that knows eBay / Facebook Marketplace URL codes.
 * Classic script (no ES module). Attaches one global: BuyLinks.
 * Uses no browser APIs (no URL, URLSearchParams, DOM) so it also runs under
 * macOS JavaScriptCore (osascript -l JavaScript). ES5 syntax on purpose.
 *
 * It only BUILDS URLs. It never fetches or scrapes anything.
 *
 * Verification notes (as of 2026-11): ebay.com and facebook.com block
 * automated requests (HTTP 403 / login wall), so nothing below could be
 * checked against the live sites. Codes were cross-checked against URLs that
 * browsers produced and that people committed to public GitHub repos, plus
 * eBay category pages found via web search. Anything not confirmed that way
 * is tagged "UNVERIFIED:". iPhone test (Nov 2026): the eBay app keeps every
 * filter from these links; the Facebook app keeps the words but drops filters.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // CODES: every site-specific constant lives here so it is easy to edit.
  // ---------------------------------------------------------------------------
  var CODES = {
    ebay: {
      base: 'https://www.ebay.com/sch/i.html',

      // Query parameter names.
      param: {
        keywords: '_nkw',            // verified (many captured URLs)
        category: '_sacat',          // verified
        minPrice: '_udlo',           // verified
        maxPrice: '_udhi',           // verified
        condition: 'LH_ItemCondition', // verified
        buyItNow: 'LH_BIN',          // verified
        auction: 'LH_Auction',       // verified
        sort: '_sop'                 // verified
      },
      // No distance filter on eBay: everything ships, so searches are nationwide.
      // (If ever needed again: _stpos=<zip>&_sadis=<mi>&_fspt=1&LH_PrefLoc=99.)

      // _sop values. 10 = Newly listed, 1 = Ending soonest (both appear in
      // captured URLs and third-party docs; the on-page sort label itself
      // was not seen live).
      sort: { newlyListed: 10, endingSoonest: 1 },

      // LH_ItemCondition values. 1000 = New, 3000 = Used, 7000 = For parts or
      // not working. 'any' / null = parameter omitted.
      condition: { 'new': '1000', used: '3000', for_parts: '7000' },

      // Category name (as stored in the user's data) -> eBay US category id.
      // Matching is case-insensitive; "·" and "," are treated the same
      // (see normalizeCategory). Unknown name -> unknownCategory (0 = all).
      // Status per id is in the trailing comment.
      unknownCategory: 0,
      categories: {
        'Wristwatches': 31387,                    // verified: ebay.com/b/.../31387 pages (Jewelry & Watches > Watches, Parts & Accessories)
        'Watches, Parts & Accessories': 260324,   // eBay /b/ pages titled "Watches, Parts & Accessories" use 260324 (14324 is the pre-restructure id)
        'Digital Cameras': 31388,                 // verified: ebay.com/b/.../31388 pages
        'Coats, Jackets & Vests': 57988,          // verified: ebay.com/b/Coats-Jackets-Vests-/57988 (this is the MEN'S category)
        "Men's Clothing": 1059,                   // verified: ebay.com/b/.../1059 pages (breadcrumb Men > Men's Clothing)
        'Kitchen, Dining & Bar': 20625,           // verified: ebay.com/b/Kitchen-Dining-Bar-/20625
        'Backpacks': 0,                           // all categories: 52357 is men's fashion backpacks and would hide hiking/ultralight packs listed under Sporting Goods
        'Film Cameras': 15230,                    // verified: ebay.com/b/15230 (Cameras & Photo > Film Photography > Film Cameras)
        'Film Photography': 69323,                // verified from an eBay category-change listing only (older page), not a live /b/ page
        'Headphones': 112529,                     // verified: ebay.com/sch/112529 and many /t/.../112529 pages
        'Men': 260012                             // verified: ebay.com/b/...-for-Men/260012 pages (Clothing, Shoes & Accessories > Men)
      }
    },

    facebook: {
      base: 'https://www.facebook.com/marketplace/',

      param: {
        query: 'query',
        sort: 'sortBy',
        minPrice: 'minPrice',
        maxPrice: 'maxPrice',
        condition: 'itemCondition',
        radius: 'radius',
        exact: 'exact'
      },

      // verified in public docs/benchmarks: creation_time_descend = Date listed: Newest first.
      sortNewest: 'creation_time_descend',

      // verified names: new, used_like_new, used_good, used_fair.
      // Multi-value separator is a comma; it is sent percent-encoded (%2C),
      // which is how Facebook's own URLs look in captured examples.
      // UNVERIFIED: one benchmark doc claims the condition filter is
      // single-select in the UI; another source and captured URLs use a
      // comma list. If "used" shows no filter on the phone, try one value.
      conditionValues: {
        'new': 'new',
        used: 'used_like_new,used_good,used_fair'
      },

      exact: 'false',

      // UNVERIFIED: whether the URL param is honoured and which unit it takes.
      // Observations conflict: one source saw radius=20 echoed back as
      // 32 km (so URL = miles), a newer one saw radius=20 -> 20 km (URL = km),
      // and a third says the UI never writes radius to the URL at all.
      // Assumed here: US account, URL value in MILES. Set radiusUnit to 'km'
      // to convert instead.
      radiusUnit: 'mi',              // 'mi' or 'km'
      kmPerMile: 1.609344,

      // Radius presets in miles (documented in a third-party Marketplace
      // playbook; UNVERIFIED against the live UI). Rounded UP, capped at max.
      radiusPresetsMi: [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500]
    }
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function isBlank(v) {
    return v === null || v === undefined || String(v).replace(/\s+/g, '') === '';
  }

  function toNumber(v) {
    if (isBlank(v)) { return null; }
    var n = Number(v);
    return (isFinite(n) && n >= 0) ? n : null;
  }

  // encodeURIComponent plus the characters it leaves alone (! ' ( ) *), so
  // the result is safe inside HTML attributes and JS strings too.
  function enc(v) {
    return encodeURIComponent(String(v)).replace(/[!'()*]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  // Keyword encoding: encodeURIComponent, but spaces as "+" like eBay itself.
  function encKeywords(s) {
    return enc(s).replace(/%20/g, '+');
  }

  function numStr(n) {
    return (Math.floor(n) === n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  // Smallest preset >= value; the largest preset if value is above them all.
  function roundUpToPreset(value, presets) {
    for (var i = 0; i < presets.length; i++) {
      if (value <= presets[i]) { return presets[i]; }
    }
    return presets[presets.length - 1];
  }

  function normalizeQuotes(s) {
    return String(s)
      .replace(/[“”„‟«»″]/g, '"')
      .replace(/[‘’‚‛′]/g, "'");
  }

  // ---------------------------------------------------------------------------
  // parseTerms("seiko quartz divers watch -solar")
  //   -> { include: "seiko quartz divers watch", exclude: ["solar"] }
  // Tokens starting with "-" are exclusions. Quoted phrases stay together:
  //   knipex "97 01 125" -used   -> include: knipex "97 01 125", exclude: ["used"]
  //   -"red label"               -> exclude: ['"red label"'] (quotes kept)
  // A lone "-" is dropped. Curly quotes are normalised to straight quotes.
  // ---------------------------------------------------------------------------
  function parseTerms(name) {
    var text = isBlank(name) ? '' : normalizeQuotes(name).replace(/\s+/g, ' ').trim();
    var tokens = text.match(/-?"[^"]*"|\S+/g) || [];
    var include = [];
    var exclude = [];

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.charAt(0) === '-') {
        var rest = t.replace(/^-+/, '');
        if (rest !== '') { exclude.push(rest); }
      } else {
        include.push(t);
      }
    }

    var inc = include.join(' ');
    if ((inc.match(/"/g) || []).length % 2 === 1) { inc = inc.replace(/"/g, ''); }  // stray unmatched quote
    exclude = exclude.map(function (x) {
      return ((x.match(/"/g) || []).length % 2 === 1) ? x.replace(/"/g, '') : x;
    }).filter(function (x) { return x !== ''; });

    return { include: inc.replace(/\s+/g, ' ').trim(), exclude: exclude };
  }

  function canSearch(item) {
    if (!item || isBlank(item.name)) { return false; }
    return parseTerms(item.name).include !== '';
  }

  // ---------------------------------------------------------------------------
  // eBay
  // ---------------------------------------------------------------------------
  // "Coats · Jackets & Vests" and "Coats, Jackets & Vests" must match alike.
  function normalizeCategory(name) {
    return normalizeQuotes(name)
      .toLowerCase()
      .replace(/[·•‧⋅,]/g, ',')
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildCategoryLookup() {
    var out = {};
    var cats = CODES.ebay.categories;
    for (var k in cats) {
      if (Object.prototype.hasOwnProperty.call(cats, k)) { out[normalizeCategory(k)] = cats[k]; }
    }
    return out;
  }

  // Name -> eBay category id (number). A bare numeric string is passed
  // through as an id. Unknown / empty -> CODES.ebay.unknownCategory (0).
  function ebayCategoryId(category) {
    if (isBlank(category)) { return CODES.ebay.unknownCategory; }
    var s = String(category).trim();
    if (/^\d+$/.test(s)) { return Number(s); }
    // Rebuilt each call so edits to CODES.ebay.categories at runtime are honoured; the table is tiny.
    var lookup = buildCategoryLookup();
    var key = normalizeCategory(s);
    return Object.prototype.hasOwnProperty.call(lookup, key) ? lookup[key] : CODES.ebay.unknownCategory;
  }

  function ebayKeywords(item) {
    var t = parseTerms(item.name);
    var parts = [t.include];
    for (var i = 0; i < t.exclude.length; i++) { parts.push('-' + t.exclude[i]); }
    return parts.join(' ');
  }

  // pairs: array of [name, value]; null/undefined values are skipped.
  function buildQuery(pairs) {
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i][1] === null || pairs[i][1] === undefined) { continue; }
      var v = pairs[i][2] === 'kw' ? encKeywords(pairs[i][1]) : enc(pairs[i][1]);
      out.push(pairs[i][0] + '=' + v);
    }
    return out.join('&');
  }

  // mode: 'bin' (Buy It Now, newly listed) or 'auction' (ending soonest).
  // settings is unused for eBay (no distance filter) but kept so all
  // builders share one signature.
  function buildEbayUrl(item, settings, mode) {
    if (!canSearch(item)) { return null; }
    var c = CODES.ebay;
    var p = c.param;
    var pairs = [];

    pairs.push([p.keywords, ebayKeywords(item), 'kw']);
    pairs.push([p.category, ebayCategoryId(item.category)]);

    if (mode === 'auction') {
      pairs.push([p.auction, 1]);
      pairs.push([p.sort, c.sort.endingSoonest]);
    } else {
      // Buy It Now; per eBay Best Offer is an add-on to fixed-price listings,
      // so these appear under the BIN filter ("or Best Offer" on the card).
      // UNVERIFIED live: could not load eBay results to confirm.
      pairs.push([p.buyItNow, 1]);
      pairs.push([p.sort, c.sort.newlyListed]);
    }

    var lo = toNumber(item.min_price);
    var hi = toNumber(item.max_price);
    if (lo !== null) { pairs.push([p.minPrice, numStr(lo)]); }
    if (hi !== null) { pairs.push([p.maxPrice, numStr(hi)]); }

    var cond = item.condition;
    if (cond && Object.prototype.hasOwnProperty.call(c.condition, cond)) {
      pairs.push([p.condition, c.condition[cond]]);
    }

    return c.base + '?' + buildQuery(pairs);
  }

  // Buy It Now only (includes "or Best Offer"), sorted Newly listed.
  function buildEbayNewUrl(item, settings) {
    return buildEbayUrl(item, settings, 'bin');
  }

  // Auctions only, sorted Ending soonest.
  function buildEbayEndingUrl(item, settings) {
    return buildEbayUrl(item, settings, 'auction');
  }

  // ---------------------------------------------------------------------------
  // Facebook Marketplace
  // ---------------------------------------------------------------------------
  // Facebook cannot exclude words, so only the include terms are used, with
  // quote characters stripped.
  function facebookQuery(item) {
    return parseTerms(item.name).include.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  }

  function facebookRadiusValue(miles) {
    var f = CODES.facebook;
    var preset = roundUpToPreset(miles, f.radiusPresetsMi);
    return f.radiusUnit === 'km' ? Math.round(preset * f.kmPerMile) : preset;
  }

  function buildFacebookUrl(item, settings) {
    if (!canSearch(item)) { return null; }
    settings = settings || {};
    var f = CODES.facebook;
    var p = f.param;
    var pairs = [];

    pairs.push([p.query, facebookQuery(item)]);
    pairs.push([p.sort, f.sortNewest]);

    var lo = toNumber(item.min_price);
    var hi = toNumber(item.max_price);
    if (lo !== null) { pairs.push([p.minPrice, Math.floor(lo)]); }
    if (hi !== null) { pairs.push([p.maxPrice, Math.ceil(hi)]); }

    var cond = item.condition;
    if (cond && Object.prototype.hasOwnProperty.call(f.conditionValues, cond)) {
      pairs.push([p.condition, f.conditionValues[cond]]);
    }

    var miles = toNumber(item.distance_mi);
    if (miles === null || miles <= 0) { miles = toNumber(settings.default_fb_radius_mi); }
    if (miles !== null && miles > 0) { pairs.push([p.radius, facebookRadiusValue(miles)]); }

    pairs.push([p.exact, f.exact]);

    var path = f.base;
    if (!isBlank(settings.fb_location_id)) {
      path += enc(String(settings.fb_location_id).trim()) + '/';
    }
    return path + 'search/?' + buildQuery(pairs);
  }

  // The Facebook link for the Facebook APP (iPhone / iPad): search words only.
  // iPhone test (Nov 2026): the app keeps the words but ignores every filter,
  // and once a location ID was in the address it showed no listings at all.
  // So the app gets no location and no filters; it searches around the
  // Marketplace location set inside the app.
  function buildFacebookAppUrl(item) {
    if (!canSearch(item)) { return null; }
    var f = CODES.facebook;
    return f.base + 'search/?' + buildQuery([[f.param.query, facebookQuery(item)]]);
  }

  // ---------------------------------------------------------------------------
  root.BuyLinks = {
    CODES: CODES,
    parseTerms: parseTerms,
    canSearch: canSearch,
    buildEbayNewUrl: buildEbayNewUrl,
    buildEbayEndingUrl: buildEbayEndingUrl,
    buildFacebookUrl: buildFacebookUrl,
    buildFacebookAppUrl: buildFacebookAppUrl,
    // The words a Facebook search uses ('' if there are none), for copying.
    facebookWords: function (item) { return canSearch(item) ? facebookQuery(item) : ''; },
    ebayCategoryId: ebayCategoryId
  };
})(typeof window !== 'undefined' ? window : this);
