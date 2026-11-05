/*
 * tests/links.test.js - unit tests for js/links.js (the global BuyLinks).
 *
 * Run from the repo root with tests/run.sh, or directly:
 *   osascript -l JavaScript tests/links.test.js
 * It runs on macOS JavaScriptCore, so Node.js is not needed.
 * Exit status: 0 when every test passes, 1 when any test fails.
 */

ObjC.import('stdlib');   // gives $.exit
ObjC.import('stdio');    // gives $.puts (writes to stdout)

// ---------------------------------------------------------------------------
// Load js/links.js. The path is relative to the repo root.
// ---------------------------------------------------------------------------
var linksSource = $.NSString.stringWithContentsOfFileEncodingError('js/links.js', $.NSUTF8StringEncoding, null);
if (!linksSource) {
  $.puts('Could not read js/links.js. Run this from the repo root (tests/run.sh does that).');
  $.exit(2);
}
eval(linksSource.js);   // sets the global BuyLinks
var BL = BuyLinks;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
var EBAY_BASE = 'https://www.ebay.com/sch/i.html?';
var FB_BASE = 'https://www.facebook.com/marketplace/search/?';
var ZIP = '10001';   // public NYC ZIP used as an example

var passed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    $.puts('PASS  ' + name);
  } catch (e) {
    failures.push(name);
    $.puts('FAIL  ' + name);
    $.puts('      ' + (e && e.message ? e.message : String(e)));
  }
}

function section(title) {
  $.puts('');
  $.puts(title);
}

function show(v) {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

function label(text) {
  return text ? text + ': ' : '';
}

function assertEqual(actual, expected, text) {
  if (actual !== expected) {
    throw new Error(label(text) + 'expected ' + show(expected) + ' but got ' + show(actual));
  }
}

function assertDeepEqual(actual, expected, text) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a !== e) { throw new Error(label(text) + 'expected ' + e + ' but got ' + a); }
}

function assertContains(haystack, needle, text) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error(label(text) + 'expected ' + show(String(haystack)) + ' to contain ' + show(needle));
  }
}

function assertNotContains(haystack, needle, text) {
  if (String(haystack).indexOf(needle) !== -1) {
    throw new Error(label(text) + 'expected ' + show(String(haystack)) + ' not to contain ' + show(needle));
  }
}

function assertStartsWith(s, prefix, text) {
  if (String(s).indexOf(prefix) !== 0) {
    throw new Error(label(text) + 'expected ' + show(s) + ' to start with ' + show(prefix));
  }
}

function assertNull(v, text) {
  if (v !== null) { throw new Error(label(text) + 'expected null but got ' + show(v)); }
}

// Query-string parsing. JavaScriptCore has no URL or URLSearchParams.
function decode(s) {
  return decodeURIComponent(String(s).replace(/\+/g, ' '));
}

function parseQuery(url) {
  var out = {};
  var q = String(url).indexOf('?');
  if (q === -1) { return out; }
  var pairs = url.slice(q + 1).split('&');
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i] === '') { continue; }
    var eq = pairs[i].indexOf('=');
    var key = decode(eq === -1 ? pairs[i] : pairs[i].slice(0, eq));
    var val = eq === -1 ? '' : decode(pairs[i].slice(eq + 1));
    out[key] = val;
  }
  return out;
}

// Decoded value of one query parameter, or undefined when it is not in the URL.
function param(url, key) {
  var q = parseQuery(url);
  return Object.prototype.hasOwnProperty.call(q, key) ? q[key] : undefined;
}

var EBAY_DISTANCE_KEYS = ['_stpos', '_sadis', '_fspt', 'LH_PrefLoc'];

// ---------------------------------------------------------------------------
// parseTerms
// ---------------------------------------------------------------------------
section('parseTerms');

test('parseTerms: -solar becomes an exclusion, not a search word', function () {
  var t = BL.parseTerms('seiko quartz divers watch -solar');
  assertEqual(t.include, 'seiko quartz divers watch', 'include');
  assertDeepEqual(t.exclude, ['solar'], 'exclude');
});

test('parseTerms: several exclusions and extra spaces are tidied', function () {
  var t = BL.parseTerms('   seiko    -solar   -cheap  ');
  assertEqual(t.include, 'seiko', 'include');
  assertDeepEqual(t.exclude, ['solar', 'cheap'], 'exclude');
});

test('parseTerms: curly quotes become straight and the phrase stays together', function () {
  var t = BL.parseTerms('knipex “97 01 125”');
  assertEqual(t.include, 'knipex "97 01 125"', 'include');
  assertDeepEqual(t.exclude, [], 'exclude');
});

test('parseTerms: straight quoted phrase plus a word exclusion', function () {
  var t = BL.parseTerms('knipex "97 01 125" -used');
  assertEqual(t.include, 'knipex "97 01 125"', 'include');
  assertDeepEqual(t.exclude, ['used'], 'exclude');
});

test('parseTerms: phrase exclusion keeps its quotes', function () {
  var t = BL.parseTerms('seiko -"red label"');
  assertEqual(t.include, 'seiko', 'include');
  assertDeepEqual(t.exclude, ['"red label"'], 'exclude');
});

test('parseTerms: curly-quoted phrase exclusion becomes straight quotes', function () {
  var t = BL.parseTerms('seiko -“red label”');
  assertDeepEqual(t.exclude, ['"red label"'], 'exclude');
});

test('parseTerms: blank names give an empty include and no exclusions', function () {
  ['', '   ', null, undefined].forEach(function (name) {
    var t = BL.parseTerms(name);
    assertEqual(t.include, '', 'include for ' + show(name));
    assertDeepEqual(t.exclude, [], 'exclude for ' + show(name));
  });
});

test('parseTerms: a name that is only -solar has no search words', function () {
  var t = BL.parseTerms('-solar');
  assertEqual(t.include, '', 'include');
  assertDeepEqual(t.exclude, ['solar'], 'exclude');
});

test('parseTerms: a lone dash is dropped', function () {
  var t = BL.parseTerms('seiko -');
  assertEqual(t.include, 'seiko', 'include');
  assertDeepEqual(t.exclude, [], 'exclude');
});

test('parseTerms: a stray unmatched quote is removed', function () {
  assertEqual(BL.parseTerms('knipex "97 01').include, 'knipex 97 01', 'include');
});

// ---------------------------------------------------------------------------
// canSearch
// ---------------------------------------------------------------------------
section('canSearch');

test('canSearch: true when the name has at least one search word', function () {
  assertEqual(BL.canSearch({ name: 'seiko' }), true, 'plain word');
  assertEqual(BL.canSearch({ name: '  seiko -solar ' }), true, 'word with exclusion');
  assertEqual(BL.canSearch({ name: 'knipex “97 01 125”' }), true, 'curly phrase');
});

test('canSearch: false for a missing, blank, or exclusion-only name', function () {
  [null, undefined, {}, { name: '' }, { name: '   ' }, { name: null }, { name: '-solar' }, { name: '-' }]
    .forEach(function (item) {
      assertEqual(BL.canSearch(item), false, 'item ' + show(item));
    });
});

// ---------------------------------------------------------------------------
// eBay: listing type, keywords
// ---------------------------------------------------------------------------
section('eBay: listing type and keywords');

test('buildEbayNewUrl: Buy It Now, newly listed', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko' }, {});
  assertStartsWith(url, EBAY_BASE, 'base');
  assertContains(url, 'LH_BIN=1', 'LH_BIN');
  assertContains(url, '_sop=10', '_sop');
  assertNotContains(url, 'LH_Auction', 'no auction filter');
  assertEqual(param(url, 'LH_BIN'), '1', 'LH_BIN value');
  assertEqual(param(url, '_sop'), '10', '_sop value');
});

test('buildEbayEndingUrl: auctions only, ending soonest', function () {
  var url = BL.buildEbayEndingUrl({ name: 'seiko' }, {});
  assertStartsWith(url, EBAY_BASE, 'base');
  assertContains(url, 'LH_Auction=1', 'LH_Auction');
  assertEqual(param(url, '_sop'), '1', '_sop value');
  assertNotContains(url, 'LH_BIN', 'no Buy It Now filter');
  assertEqual(param(url, 'LH_BIN'), undefined, 'LH_BIN key');
});

test('eBay keywords keep -solar as an exclusion', function () {
  var item = { name: 'seiko quartz divers watch -solar' };
  var newUrl = BL.buildEbayNewUrl(item, {});
  var endUrl = BL.buildEbayEndingUrl(item, {});
  assertEqual(param(newUrl, '_nkw'), 'seiko quartz divers watch -solar', 'new keywords');
  assertEqual(param(endUrl, '_nkw'), 'seiko quartz divers watch -solar', 'ending keywords');
  assertContains(newUrl, '_nkw=seiko+quartz+divers+watch+-solar', 'encoded form');
});

test('eBay keywords: curly-quoted phrase reaches eBay as straight quotes', function () {
  var url = BL.buildEbayNewUrl({ name: 'knipex “97 01 125”' }, {});
  assertEqual(param(url, '_nkw'), 'knipex "97 01 125"', '_nkw');
});

test('eBay keywords: phrase exclusion is sent as -"red label"', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko -"red label"' }, {});
  assertEqual(param(url, '_nkw'), 'seiko -"red label"', '_nkw');
});

test('builders accept a missing settings argument', function () {
  assertStartsWith(BL.buildEbayNewUrl({ name: 'seiko' }), EBAY_BASE, 'eBay new');
  assertStartsWith(BL.buildEbayEndingUrl({ name: 'seiko' }), EBAY_BASE, 'eBay ending');
  assertStartsWith(BL.buildFacebookUrl({ name: 'seiko' }), FB_BASE, 'Facebook');
});

// ---------------------------------------------------------------------------
// Facebook: query, sort
// ---------------------------------------------------------------------------
section('Facebook: query and sort');

test('Facebook query drops -solar (eBay keeps it)', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko quartz divers watch -solar' }, {});
  assertEqual(param(fb, 'query'), 'seiko quartz divers watch', 'query');
  assertNotContains(fb, 'solar', 'no exclusion word anywhere in the URL');
});

test('Facebook query drops quote marks but keeps the phrase words', function () {
  var fb = BL.buildFacebookUrl({ name: 'knipex “97 01 125”' }, {});
  assertEqual(param(fb, 'query'), 'knipex 97 01 125', 'query');
});

test('Facebook: newest first, exact match off', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko' }, {});
  assertStartsWith(fb, FB_BASE, 'base');
  assertEqual(param(fb, 'sortBy'), 'creation_time_descend', 'sortBy');
  assertEqual(param(fb, 'exact'), 'false', 'exact');
});

// ---------------------------------------------------------------------------
// Blank names
// ---------------------------------------------------------------------------
section('Builders return null for a blank name');

test('all three builders return null for blank or exclusion-only names', function () {
  [{ name: '' }, { name: '   ' }, { name: null }, { name: '-solar' }, null].forEach(function (item) {
    assertNull(BL.buildEbayNewUrl(item, {}), 'eBay new for ' + show(item));
    assertNull(BL.buildEbayEndingUrl(item, {}), 'eBay ending for ' + show(item));
    assertNull(BL.buildFacebookUrl(item, {}), 'Facebook for ' + show(item));
  });
});

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------
section('Price');

test('eBay price: min only sends _udlo and no _udhi', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', min_price: 20 }, {});
  assertEqual(param(url, '_udlo'), '20', '_udlo');
  assertNotContains(url, '_udhi', 'no _udhi');
});

test('eBay price: max only sends _udhi and no _udlo', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', max_price: 100 }, {});
  assertEqual(param(url, '_udhi'), '100', '_udhi');
  assertNotContains(url, '_udlo', 'no _udlo');
});

test('eBay price: min and max together', function () {
  var url = BL.buildEbayEndingUrl({ name: 'seiko', min_price: 20, max_price: 100 }, {});
  assertEqual(param(url, '_udlo'), '20', '_udlo');
  assertEqual(param(url, '_udhi'), '100', '_udhi');
});

test('eBay price: none sends neither _udlo nor _udhi', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko' }, {});
  assertNotContains(url, '_udlo', 'no _udlo');
  assertNotContains(url, '_udhi', 'no _udhi');
});

test('eBay price: database-style string prices are normalised', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', min_price: '19.50', max_price: '100.00' }, {});
  assertEqual(param(url, '_udlo'), '19.5', '_udlo');
  assertEqual(param(url, '_udhi'), '100', '_udhi');
});

test('Facebook price: min only sends minPrice and no maxPrice', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', min_price: 20 }, {});
  assertEqual(param(fb, 'minPrice'), '20', 'minPrice');
  assertNotContains(fb, 'maxPrice', 'no maxPrice');
});

test('Facebook price: max only sends maxPrice and no minPrice', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', max_price: 100 }, {});
  assertEqual(param(fb, 'maxPrice'), '100', 'maxPrice');
  assertNotContains(fb, 'minPrice', 'no minPrice');
});

test('Facebook price: min and max together', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', min_price: 20, max_price: 100 }, {});
  assertEqual(param(fb, 'minPrice'), '20', 'minPrice');
  assertEqual(param(fb, 'maxPrice'), '100', 'maxPrice');
});

test('Facebook price: none sends neither minPrice nor maxPrice', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko' }, {});
  assertNotContains(fb, 'minPrice', 'no minPrice');
  assertNotContains(fb, 'maxPrice', 'no maxPrice');
});

test('Facebook price: min rounds down and max rounds up to whole dollars', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', min_price: 19.99, max_price: 100.5 }, {});
  assertEqual(param(fb, 'minPrice'), '19', 'minPrice');
  assertEqual(param(fb, 'maxPrice'), '101', 'maxPrice');
});

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------
section('Condition');

test('eBay condition: used gives LH_ItemCondition=3000', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', condition: 'used' }, {});
  assertContains(url, 'LH_ItemCondition=3000', 'raw');
  assertEqual(param(url, 'LH_ItemCondition'), '3000', 'value');
});

test('eBay condition: new is 1000 and for_parts is 7000', function () {
  assertEqual(param(BL.buildEbayNewUrl({ name: 'seiko', condition: 'new' }, {}), 'LH_ItemCondition'), '1000', 'new');
  assertEqual(param(BL.buildEbayNewUrl({ name: 'seiko', condition: 'for_parts' }, {}), 'LH_ItemCondition'), '7000', 'for_parts');
});

test('eBay condition: any gives no condition parameter', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', condition: 'any' }, {});
  assertNotContains(url, 'LH_ItemCondition', 'no condition param');
});

test('eBay condition: an unknown value gives no condition parameter', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', condition: 'bogus' }, {});
  assertNotContains(url, 'LH_ItemCondition', 'no condition param');
});

test('Facebook condition: used sends the three used values', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', condition: 'used' }, {});
  assertContains(fb, 'itemCondition=used_like_new%2Cused_good%2Cused_fair', 'raw');
});

test('Facebook condition: new sends itemCondition=new; any sends nothing', function () {
  var newFb = BL.buildFacebookUrl({ name: 'seiko', condition: 'new' }, {});
  assertEqual(param(newFb, 'itemCondition'), 'new', 'new');
  var anyFb = BL.buildFacebookUrl({ name: 'seiko', condition: 'any' }, {});
  assertNotContains(anyFb, 'itemCondition', 'any');
});

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------
section('Distance');

test('eBay ignores distance (everything ships): no distance params even with ZIP + distance', function () {
  var settings = { home_zip: ZIP };
  [BL.buildEbayNewUrl, BL.buildEbayEndingUrl].forEach(function (build) {
    var url = build({ name: 'seiko', distance_mi: 30 }, settings);
    EBAY_DISTANCE_KEYS.forEach(function (key) {
      assertEqual(param(url, key), undefined, key);
    });
    assertNotContains(url, ZIP, 'ZIP must not appear in eBay URL');
  });
});

test('Facebook radius: distance rounds up to the next preset (50 -> 60)', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', distance_mi: 50 }, {});
  assertContains(fb, 'radius=60', 'raw');
  assertEqual(param(fb, 'radius'), '60', 'radius');
});

test('Facebook radius: falls back to default_fb_radius_mi when the item has no distance', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko' }, { default_fb_radius_mi: 50 });
  assertEqual(param(fb, 'radius'), '60', 'radius');
});

test('Facebook radius: the item distance wins over the default', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', distance_mi: 10 }, { default_fb_radius_mi: 50 });
  assertEqual(param(fb, 'radius'), '10', 'radius');
});

test('Facebook radius: no distance and no default means no radius parameter', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko' }, {});
  assertEqual(param(fb, 'radius'), undefined, 'radius');
});

test('Facebook radius: a distance above the largest preset caps at 500', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko', distance_mi: 600 }, {});
  assertEqual(param(fb, 'radius'), '500', 'radius');
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
section('Categories');

test('eBay category: "Wristwatches" -> _sacat=31387', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', category: 'Wristwatches' }, {});
  assertContains(url, '_sacat=31387', 'raw');
  assertEqual(BL.ebayCategoryId('Wristwatches'), 31387, 'ebayCategoryId');
});

test('eBay category: "Watches · Parts & Accessories" -> 260324', function () {
  assertEqual(BL.ebayCategoryId('Watches · Parts & Accessories'), 260324, 'ebayCategoryId');
  assertEqual(param(BL.buildEbayNewUrl({ name: 'seiko', category: 'Watches · Parts & Accessories' }, {}), '_sacat'), '260324', '_sacat');
});

test('eBay category: the comma spelling maps to the same id', function () {
  assertEqual(BL.ebayCategoryId('Watches, Parts & Accessories'), 260324, 'ebayCategoryId');
});

test('eBay category: matching ignores case and spacing around separators', function () {
  assertEqual(BL.ebayCategoryId('wristwatches'), 31387, 'lower case');
  assertEqual(BL.ebayCategoryId('Coats · Jackets & Vests'), 57988, 'middle dot with spaces');
  assertEqual(BL.ebayCategoryId('Coats,Jackets & Vests'), 57988, 'comma without spaces');
});

test('eBay category: an unknown name gives _sacat=0 (all categories)', function () {
  var url = BL.buildEbayNewUrl({ name: 'seiko', category: 'Nonexistent Thing' }, {});
  assertEqual(BL.ebayCategoryId('Nonexistent Thing'), 0, 'ebayCategoryId');
  assertEqual(param(url, '_sacat'), '0', '_sacat');
});

test('eBay category: "Backpacks" deliberately maps to 0 (all categories)', function () {
  assertEqual(BL.ebayCategoryId('Backpacks'), 0, 'ebayCategoryId');
  assertEqual(param(BL.buildEbayNewUrl({ name: 'pack', category: 'Backpacks' }, {}), '_sacat'), '0', '_sacat');
});

test('eBay category: a blank or missing category gives 0', function () {
  ['', '   ', null, undefined].forEach(function (c) {
    assertEqual(BL.ebayCategoryId(c), 0, 'category ' + show(c));
  });
});

test('eBay category: a numeric id is passed through', function () {
  assertEqual(BL.ebayCategoryId('31388'), 31388, 'ebayCategoryId');
});

// ---------------------------------------------------------------------------
// Facebook location
// ---------------------------------------------------------------------------
section('Facebook location');

test('Facebook location: fb_location_id goes into the path', function () {
  var fb = BL.buildFacebookUrl({ name: 'seiko' }, { fb_location_id: '123456789' });
  assertStartsWith(fb, 'https://www.facebook.com/marketplace/123456789/search/?', 'path');
});

test('Facebook location: a missing, null or blank id is left out of the path', function () {
  [{}, { fb_location_id: null }, { fb_location_id: '' }, { fb_location_id: '   ' }].forEach(function (settings) {
    var fb = BL.buildFacebookUrl({ name: 'seiko' }, settings);
    assertStartsWith(fb, FB_BASE, 'settings ' + show(settings));
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
var total = passed + failures.length;
$.puts('');
$.puts(passed + ' passed, ' + failures.length + ' failed, ' + total + ' total');
if (failures.length > 0) {
  $.puts('Failed: ' + failures.join(' | '));
  $.exit(1);
}
$.exit(0);
