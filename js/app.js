/*
 * app.js - Buy List Finder main page.
 *
 * Security rule for this file: every value that comes from the database (or
 * from the localStorage copy of it) is untrusted, because AI agents write
 * some of it from web content. So:
 *   - No innerHTML / insertAdjacentHTML / document.write anywhere.
 *   - DOM is built with createElement + textContent (see h()).
 *   - The only href values ever set are straight from the BuyLinks builders
 *     (see linkEl()).
 *   - Values used as class names go through oneOf() whitelists.
 */
(function () {
  'use strict';

  var DB = window.BuyDB;
  var Links = window.BuyLinks;

  var CACHE_KEY = 'blf_cache_v1';
  var LEGACY_MODE_KEY = 'blf_open_mode';   // old App/Safari toggle, now removed
  var NO_CATEGORY = '__none__';

  var SEARCH_ON = ['both', 'ebay', 'facebook'];
  var STATUSES = ['hunting', 'paused', 'bought'];
  var PRIORITIES = ['high', 'normal', 'low'];
  var CONDITIONS = ['any', 'new', 'used', 'for_parts'];
  var CONFIDENCES = ['high', 'medium', 'low'];
  var CONDITION_LABEL = { any: 'Any', 'new': 'New', used: 'Used', for_parts: 'For parts' };
  var TOGGLES = ['highOnly', 'fbOnly', 'noAlert'];
  var REFRESH_AFTER_MS = 60 * 1000;

  var state = {
    items: [],
    settings: null,
    loaded: false,          // we have items on screen (cache or server)
    loadError: '',          // shown only when nothing is loaded
    userId: null,
    email: '',
    status: 'hunting',      // hunting | paused | bought | all
    highOnly: false,
    fbOnly: false,
    noAlert: false,
    category: '',
    query: '',
    expandedId: null,       // string id
    lastRefresh: 0
  };
  var refreshing = false;

  // ---------------------------------------------------------------------------
  // Small DOM helpers (no innerHTML)
  // ---------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function appendKids(el, kid) {
    if (kid === null || kid === undefined || kid === false) { return; }
    if (Array.isArray(kid)) { for (var i = 0; i < kid.length; i++) { appendKids(el, kid[i]); } return; }
    if (kid.nodeType) { el.appendChild(kid); return; }
    el.appendChild(document.createTextNode(String(kid)));
  }

  // h('div', {class: 'x', 'data-id': 3}, child, 'text', [more])
  // href / src / style / on* are refused on purpose: links go through linkEl().
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) { continue; }
        var v = attrs[k];
        if (v === null || v === undefined || v === false) { continue; }
        if (k === 'href' || k === 'src' || k === 'srcdoc' || k === 'style' || k.indexOf('on') === 0) {
          throw new Error('h(): attribute not allowed: ' + k);
        }
        if (k === 'class') { el.className = v; }
        else if (k === 'text') { el.textContent = v; }
        else { el.setAttribute(k, v === true ? '' : String(v)); }
      }
    }
    for (var i = 2; i < arguments.length; i++) { appendKids(el, arguments[i]); }
    return el;
  }

  function clear(el) { while (el.firstChild) { el.removeChild(el.firstChild); } }

  // ---------------------------------------------------------------------------
  // Value helpers
  // ---------------------------------------------------------------------------
  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function nonEmpty(v) { return str(v).trim() !== ''; }
  function oneOf(v, allowed, fallback) { return allowed.indexOf(v) !== -1 ? v : fallback; }

  function num(v) {
    if (v === null || v === undefined || v === '') { return null; }
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function money(n) {
    var cents = Math.round(n * 100);
    var whole = cents % 100 === 0;
    return '$' + (cents / 100).toLocaleString('en-US', {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2
    });
  }

  function fmtDate(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // ---------------------------------------------------------------------------
  // Link opening - the ONE place that decides how a link is opened.
  // Every button is a plain <a href> straight to the BuyLinks URL (never JS
  // navigation: iOS only hands real link taps to the eBay / Facebook apps).
  //   Desktop: new tab (target=_blank rel=noopener).
  //   iPhone/iPad: plain same-tab link, no target.
  // ---------------------------------------------------------------------------
  var IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function linkTargetAttrs() {
    return IS_IOS ? null : { target: '_blank', rel: 'noopener' };
  }

  // The only function that sets an href. `url` must come from a BuyLinks builder.
  function linkEl(url, className, kids) {
    var a = h('a', { 'class': className }, kids);
    a.setAttribute('href', url);
    var extra = linkTargetAttrs();
    if (extra) {
      a.setAttribute('target', extra.target);
      a.setAttribute('rel', extra.rel);
    }
    return a;
  }

  // ---------------------------------------------------------------------------
  // Cache (localStorage)
  // ---------------------------------------------------------------------------
  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) { return null; }
      var c = JSON.parse(raw);
      if (!c || !Array.isArray(c.items)) { return null; }
      return c;
    } catch (e) { return null; }
  }
  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ items: state.items, settings: state.settings, savedAt: Date.now() }));
    } catch (e) { /* private mode / quota: not fatal */ }
  }
  function clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Toast + banner
  // ---------------------------------------------------------------------------
  var toastTimer = null;
  function toast(message, isError) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' is-error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }

  function setBanner(message) {
    $('banner').hidden = !message;
    $('banner-text').textContent = message || '';
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function showScreen(name) {
    $('boot').hidden = name !== 'boot';
    $('screen-login').hidden = name !== 'login';
    $('screen-app').hidden = name !== 'app';
    if (name === 'app') { measureHeader(); }
  }

  function bootError(message) {
    showScreen('boot');
    $('boot-msg').textContent = message;
    $('boot-reload').hidden = false;
  }

  function measureHeader() {
    var tb = $('topbar');
    if (tb && tb.offsetHeight) { document.documentElement.style.setProperty('--hdr-h', tb.offsetHeight + 'px'); }
  }

  function closeAllDialogs() {
    ['editor', 'settings', 'confirm'].forEach(function (id) {
      var d = $(id);
      if (d.open) { d.close(); }
    });
  }

  function syncModalClass() {
    var any = $('editor').open || $('settings').open || $('confirm').open;
    document.body.classList.toggle('modal-open', any);
  }

  // Back to the sign-in screen, forgetting everything on this device.
  function leaveApp(message) {
    state.items = [];
    state.settings = null;
    state.loaded = false;
    state.loadError = '';
    state.userId = null;
    state.email = '';
    state.expandedId = null;
    clearCache();
    closeAllDialogs();
    setBanner('');
    clear($('list'));
    showScreen('login');
    var err = $('login-error');
    err.hidden = !message;
    err.textContent = message || '';
    $('login-password').value = '';
    $('login-submit').disabled = false;
    $('login-submit').textContent = 'Sign in';
  }

  function handleError(e, fallback) {
    if (e && e.kind === 'auth') {
      leaveApp('Your session expired. Please sign in again.');
      return true;
    }
    toast((e && e.message) || fallback || 'Something went wrong.', true);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Items: merge, filter
  // ---------------------------------------------------------------------------
  function mergeItem(row) {
    var found = false;
    for (var i = 0; i < state.items.length; i++) {
      if (String(state.items[i].id) === String(row.id)) { state.items[i] = row; found = true; break; }
    }
    if (!found) { state.items.push(row); }
    state.items = DB.sortItems(state.items);
  }

  function removeItem(id) {
    state.items = state.items.filter(function (it) { return String(it.id) !== String(id); });
    if (state.expandedId === String(id)) { state.expandedId = null; }
  }

  function searchedSites(item) {
    var s = oneOf(item.search_on, SEARCH_ON, 'both');
    return s === 'both' ? ['ebay', 'facebook'] : [s];
  }

  // High priority and at least one searched site has no alert on yet.
  function needsAlert(item) {
    if (item.priority !== 'high') { return false; }
    return searchedSites(item).some(function (site) {
      return !(site === 'ebay' ? item.ebay_alert : item.fb_alert);
    });
  }

  function hasAnyAlert(item) { return !!(item.ebay_alert || item.fb_alert); }

  function catKey(c) { return str(c).trim().toLowerCase(); }

  function matchesFilters(item) {
    if (state.status !== 'all' && item.status !== state.status) { return false; }
    if (state.highOnly && item.priority !== 'high') { return false; }
    if (state.fbOnly && item.search_on !== 'facebook') { return false; }
    if (state.noAlert && !needsAlert(item)) { return false; }
    if (state.category) {
      if (state.category === NO_CATEGORY) {
        if (nonEmpty(item.category)) { return false; }
      } else if (catKey(item.category) !== catKey(state.category)) {
        return false;
      }
    }
    var q = state.query.trim().toLowerCase();
    if (q) {
      var hay = [item.name, item.what_counts, item.my_notes, item.research_notes].map(str).join('\n').toLowerCase();
      var words = q.split(/\s+/);
      for (var i = 0; i < words.length; i++) {
        if (hay.indexOf(words[i]) === -1) { return false; }
      }
    }
    return true;
  }

  function effectiveTarget(item) {
    var mine = num(item.my_target);
    if (mine !== null) { return { value: mine, label: 'yours' }; }
    var sug = num(item.suggested_target);
    if (sug !== null) { return { value: sug, label: 'suggested' }; }
    return null;
  }

  function categoriesInUse() {
    var seen = {};
    var out = [];
    state.items.forEach(function (it) {
      var c = str(it.category).trim();
      if (c && !seen[catKey(c)]) { seen[catKey(c)] = true; out.push(c); }
    });
    out.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: 'base' }); });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Rendering: top-level
  // ---------------------------------------------------------------------------
  function renderAll() {
    renderChips();
    renderCategorySelect();
    renderList();
  }

  function renderChips() {
    var chips = $('chips').querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var on = c.dataset.status ? state.status === c.dataset.status : !!state[c.dataset.toggle];
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function renderCategorySelect() {
    var sel = $('category-filter');
    var cats = categoriesInUse();
    var valid = state.category === '' || state.category === NO_CATEGORY ||
      cats.some(function (c) { return catKey(c) === catKey(state.category); });
    if (!valid) { state.category = ''; }

    clear(sel);
    sel.appendChild(h('option', { value: '' }, 'All categories'));
    cats.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
    if (state.items.some(function (it) { return !nonEmpty(it.category); })) {
      sel.appendChild(h('option', { value: NO_CATEGORY }, 'No category'));
    }
    sel.value = state.category;
    if (sel.value !== state.category) { sel.value = ''; state.category = ''; }
  }

  // Keep keyboard focus on the "same" control after the list is rebuilt.
  function renderList() {
    var active = document.activeElement;
    var fk = active && active.dataset ? active.dataset.fk : null;

    var list = $('list');
    clear(list);
    var shown = state.items.filter(matchesFilters);
    var frag = document.createDocumentFragment();
    shown.forEach(function (item) { frag.appendChild(buildItem(item)); });
    list.appendChild(frag);

    var total = state.items.length;
    $('count').textContent = !state.loaded ? '' :
      (shown.length === total ? plural(total, 'item', 'items') : shown.length + ' of ' + plural(total, 'item', 'items'));

    renderEmpty(shown.length, total);

    if (fk) {
      var again = list.querySelector('[data-fk="' + fk.replace(/"/g, '') + '"]');
      if (again) { again.focus({ preventScroll: true }); }
    }
  }

  function renderEmpty(shownCount, total) {
    var box = $('empty');
    var text = $('empty-text');
    var action = $('empty-action');
    action.hidden = true;
    action.onclick = null;

    if (shownCount > 0) { box.hidden = true; return; }
    box.hidden = false;

    if (!state.loaded) {
      if (state.loadError) {
        text.textContent = state.loadError;
        action.textContent = 'Try again';
        action.hidden = false;
        action.onclick = function () { refresh(); };
      } else {
        text.textContent = 'Loading your list…';
      }
    } else if (total === 0) {
      text.textContent = 'Nothing on your list yet.';
      action.textContent = 'Add your first item';
      action.hidden = false;
      action.onclick = function () { openEditor(null); };
    } else {
      text.textContent = 'No items match these filters.';
      action.textContent = 'Show all items';
      action.hidden = false;
      action.onclick = function () {
        state.status = 'all'; state.highOnly = false; state.fbOnly = false; state.noAlert = false;
        state.category = ''; state.query = '';
        $('search').value = '';
        renderAll();
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering: one list item
  // ---------------------------------------------------------------------------
  function priceLine(item) {
    var usual = num(item.usual_price);
    var low = num(item.sold_low);
    var high = num(item.sold_high);
    var parts = [];

    if (usual !== null) {
      parts.push(h('span', null, 'Usually ' + money(usual)));
    } else if (low !== null && high !== null) {
      parts.push(h('span', null, 'Sold ' + money(low) + '–' + money(high)));
    } else if (low !== null) {
      parts.push(h('span', null, 'Sold from ' + money(low)));
    } else if (high !== null) {
      parts.push(h('span', null, 'Sold up to ' + money(high)));
    } else {
      parts.push(h('span', null, 'No price data'));
    }

    var t = effectiveTarget(item);
    if (t) {
      parts.push(h('span', null, 'Target ' + money(t.value), h('em', { 'class': 'tag' }, ' (' + t.label + ')')));
    } else {
      parts.push(h('span', null, 'No target'));
    }

    var kids = [];
    parts.forEach(function (p, i) {
      if (i > 0) { kids.push(' · '); }
      kids.push(p);
    });
    return h('span', { 'class': 'price' }, kids);
  }

  // `spoken` replaces the visible symbol for screen readers.
  function badge(text, spoken) {
    if (!spoken) { return h('span', { 'class': 'badge' }, text); }
    return h('span', { 'class': 'badge' },
      h('span', { 'aria-hidden': 'true' }, text),
      h('span', { 'class': 'sr-only' }, spoken));
  }

  function badgesFor(item) {
    var out = [];
    var cond = oneOf(item.condition, CONDITIONS, 'any');
    if (cond !== 'any') { out.push(badge(CONDITION_LABEL[cond])); }
    var max = num(item.max_price);
    if (max !== null) { out.push(badge('≤ ' + money(max), 'Max price ' + money(max))); }
    if (hasAnyAlert(item)) {
      var which = [];
      if (item.ebay_alert) { which.push('eBay'); }
      if (item.fb_alert) { which.push('Facebook'); }
      out.push(badge('🔔', 'Alert on: ' + which.join(' and ')));
    }
    if (item.priority === 'high') { out.push(badge('★', 'High priority')); }
    if (item.search_on === 'facebook') { out.push(badge('FB only')); }
    if (item.status === 'paused') { out.push(badge('Paused')); }
    if (item.status === 'bought') { out.push(badge('Bought')); }
    return out;
  }

  function buildItem(item) {
    var id = String(item.id);
    var status = oneOf(item.status, STATUSES, 'hunting');
    var expanded = state.expandedId === id;

    var li = h('li', { 'class': 'item is-' + status, 'data-id': id });
    var row = h('button', {
      type: 'button', 'class': 'row',
      'aria-expanded': expanded ? 'true' : 'false',
      'aria-controls': 'detail-' + id,
      'data-fk': 'row:' + id
    },
      h('span', { 'class': 'row-main' },
        h('span', { 'class': 'row-title' },
          h('span', { 'class': 'name' }, str(item.name) || '(no name)'),
          h('span', { 'class': 'id' }, '#' + id)),
        priceLine(item),
        h('span', { 'class': 'badges' }, badgesFor(item))),
      h('span', { 'class': 'chev', 'aria-hidden': 'true' }, '›'));
    li.appendChild(row);
    if (expanded) { li.appendChild(buildDetail(item)); }
    return li;
  }

  // ---------------------------------------------------------------------------
  // Rendering: expanded card
  // ---------------------------------------------------------------------------
  function priceRangeText(item) {
    var lo = num(item.min_price);
    var hi = num(item.max_price);
    if (lo !== null && hi !== null) { return money(lo) + '–' + money(hi); }
    if (lo !== null) { return 'from ' + money(lo); }
    if (hi !== null) { return 'up to ' + money(hi); }
    return 'any price';
  }

  // Distance only applies to Facebook (eBay always searches nationwide).
  function distanceText(item, settings) {
    var miles = num(item.distance_mi);
    if (miles === null || miles <= 0) { miles = num(settings && settings.default_fb_radius_mi); }
    return 'Facebook: ' + (miles !== null && miles > 0 ? 'within ' + miles + ' mi' : 'default radius');
  }

  function facts(rows) {
    var dl = h('dl', { 'class': 'facts' });
    rows.forEach(function (r) {
      dl.appendChild(h('dt', null, r[0]));
      dl.appendChild(h('dd', null, r[1]));
    });
    return dl;
  }

  function section(title, body) {
    return h('section', null, h('h3', { 'class': 'section-title' }, title), body);
  }

  function filtersSection(item, settings) {
    var rows = [
      ['Category', nonEmpty(item.category) ? str(item.category).trim() : 'any'],
      ['Condition', CONDITION_LABEL[oneOf(item.condition, CONDITIONS, 'any')].toLowerCase()],
      ['Price', priceRangeText(item)]
    ];
    if (searchedSites(item).indexOf('facebook') !== -1) {
      rows.push(['Distance', distanceText(item, settings)]);
    }
    return section('Filters', h('div', null, facts(rows)));
  }

  function researchSection(item) {
    var low = num(item.sold_low);
    var high = num(item.sold_high);
    var sales = num(item.sales_found);
    var conf = oneOf(item.confidence, CONFIDENCES, '');
    var rows = [];

    if (low !== null || high !== null) {
      var range = (low !== null && high !== null) ? money(low) + '–' + money(high) :
        (low !== null ? 'from ' + money(low) : 'up to ' + money(high));
      rows.push(['Sold range', range]);
    }
    if (sales !== null || conf) {
      var bits = [];
      if (sales !== null) { bits.push(plural(sales, 'sale', 'sales') + ' found'); }
      if (conf) { bits.push(conf + ' confidence'); }
      rows.push(['Evidence', bits.join(' · ')]);
    }

    var body = h('div', null);
    if (rows.length) { body.appendChild(facts(rows)); }
    if (nonEmpty(item.research_notes)) {
      body.appendChild(h('p', { 'class': 'note-text' + (rows.length ? ' note-gap' : '') }, str(item.research_notes)));
    }
    if (nonEmpty(item.researched_by) || nonEmpty(item.researched_at)) {
      var when = fmtDate(item.researched_at);
      var who = nonEmpty(item.researched_by) ? ' by ' + str(item.researched_by).trim() : '';
      body.appendChild(h('p', { 'class': 'hint' }, 'Researched' + who + (when ? ' on ' + when : '')));
    }
    if (!rows.length && !nonEmpty(item.research_notes) && !nonEmpty(item.researched_by) && !nonEmpty(item.researched_at)) {
      body.appendChild(h('p', { 'class': 'muted' }, 'No research yet.'));
    }

    var out = [section('Research', body)];
    if (nonEmpty(item.my_notes)) {
      out.push(section('My notes', h('p', { 'class': 'note-text' }, str(item.my_notes))));
    }
    return out;
  }

  var NO_SEARCH_REASON = 'Add a search word to the name first';

  function linkButton(url, label, sub, kind) {
    var cls = 'linkbtn ' + kind;
    if (!url) {
      return h('a', { 'class': cls + ' is-disabled', 'aria-disabled': 'true', role: 'link' },
        h('span', null, label), h('span', { 'class': 'sub' }, NO_SEARCH_REASON));
    }
    return linkEl(url, cls, [h('span', null, label), sub ? h('span', { 'class': 'sub' }, sub) : null]);
  }

  // iPhone only: the Facebook app keeps the words but drops the filters, so
  // spell out what to set by hand.
  function fbAppHint(item, settings) {
    var parts = ['Newest first'];
    var lo = num(item.min_price);
    var hi = num(item.max_price);
    if (lo !== null && hi !== null) { parts.push(money(lo) + '\u2013' + money(hi)); }
    else if (lo !== null) { parts.push('from ' + money(lo)); }
    else if (hi !== null) { parts.push('up to ' + money(hi)); }
    var cond = oneOf(item.condition, CONDITIONS, 'any');
    if (cond !== 'any') { parts.push(CONDITION_LABEL[cond]); }
    var miles = num(item.distance_mi);
    if (miles === null || miles <= 0) { miles = num(settings && settings.default_fb_radius_mi); }
    if (miles !== null && miles > 0) { parts.push('within ' + miles + ' mi'); }
    return 'In the app, set: ' + parts.join(' \u00b7 ');
  }

  function linksSection(item, settings) {
    var sites = searchedSites(item);
    var wrap = h('div', { 'class': 'links' });
    var target = effectiveTarget(item);

    if (sites.indexOf('ebay') !== -1) {
      wrap.appendChild(linkButton(Links.buildEbayNewUrl(item, settings), 'eBay New', 'Buy It Now, newest first', 'ebay'));
      wrap.appendChild(linkButton(Links.buildEbayEndingUrl(item, settings), 'eBay Ending soon',
        target ? 'Max bid ' + money(target.value) : 'Auctions, ending soonest', 'ending'));
    }
    if (sites.indexOf('facebook') !== -1) {
      var fbUrl = Links.buildFacebookUrl(item, settings);
      var fbBtn = linkButton(fbUrl, 'Facebook', 'Marketplace, newest first', 'fb');
      if (IS_IOS && fbUrl) {
        wrap.appendChild(h('div', { 'class': 'link-group' }, fbBtn,
          h('p', { 'class': 'hint fb-hint' }, fbAppHint(item, settings))));
      } else {
        wrap.appendChild(fbBtn);
      }
    }
    return wrap;
  }

  var ALERT_HINT = {
    ebay: 'In the eBay app tap Save search, then turn on notifications.',
    facebook: 'In the Facebook app, save the search or turn on notifications if offered.'
  };

  function alertRow(item, site, url) {
    var field = site === 'ebay' ? 'ebay_alert' : 'fb_alert';
    var siteName = site === 'ebay' ? 'eBay' : 'Facebook';
    var label = site === 'ebay' ? 'Set up eBay alert' : 'Set up FB alert';

    var link = url ?
      linkEl(url, 'alert-link', label) :
      h('a', { 'class': 'alert-link is-disabled', 'aria-disabled': 'true', role: 'link' }, label);

    var cb = h('input', { type: 'checkbox', 'data-fk': 'alert:' + item.id + ':' + field });
    cb.checked = !!item[field];
    cb.addEventListener('change', function () { saveAlert(item, field, cb); });

    return h('div', { 'class': 'alert-block' },
      h('div', { 'class': 'alert-row' },
        link,
        h('label', { 'class': 'check' }, cb, h('span', null, siteName + ' alert on'))),
      h('p', { 'class': 'hint' }, ALERT_HINT[site]));
  }

  function alertsSection(item, settings) {
    var sites = searchedSites(item);
    var box = h('div', { 'class': 'alerts' });
    if (sites.indexOf('ebay') !== -1) { box.appendChild(alertRow(item, 'ebay', Links.buildEbayNewUrl(item, settings))); }
    if (sites.indexOf('facebook') !== -1) { box.appendChild(alertRow(item, 'facebook', Links.buildFacebookUrl(item, settings))); }
    return section('Alerts', box);
  }

  function buildDetail(item) {
    var settings = state.settings || {};
    var d = h('div', { 'class': 'detail', id: 'detail-' + item.id });

    if (nonEmpty(item.what_counts)) {
      d.appendChild(h('div', { 'class': 'what-counts' },
        h('span', { 'class': 'label' }, 'What counts'),
        h('span', { 'class': 'text' }, str(item.what_counts))));
    }
    d.appendChild(filtersSection(item, settings));
    researchSection(item).forEach(function (s) { d.appendChild(s); });
    d.appendChild(linksSection(item, settings));
    d.appendChild(alertsSection(item, settings));

    var edit = h('button', { type: 'button', 'class': 'btn btn-block', 'data-fk': 'edit:' + item.id }, 'Edit');
    edit.addEventListener('click', function () { openEditor(item); });
    d.appendChild(h('div', { 'class': 'detail-actions' }, edit));
    return d;
  }

  // ---------------------------------------------------------------------------
  // Expand / collapse (touches only the two affected rows)
  // ---------------------------------------------------------------------------
  function itemById(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (String(state.items[i].id) === String(id)) { return state.items[i]; }
    }
    return null;
  }

  function toggleExpand(id) {
    id = String(id);
    state.expandedId = state.expandedId === id ? null : id;
    var lis = $('list').children;
    var openLi = null;
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var open = li.dataset.id === state.expandedId;
      var row = li.firstElementChild;
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      var existing = li.querySelector('.detail');
      if (open && !existing) {
        var item = itemById(li.dataset.id);
        if (item) { li.appendChild(buildDetail(item)); }
        openLi = li;
      } else if (!open && existing) {
        li.removeChild(existing);
      }
    }
    if (openLi && openLi.scrollIntoView) { openLi.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------------------------------------------------------------------------
  // Saving an alert checkbox straight from the card
  // ---------------------------------------------------------------------------
  async function saveAlert(item, field, cb) {
    var want = cb.checked;
    var key = cb.dataset.fk;
    var hadFocus = document.activeElement === cb;
    cb.disabled = true;
    try {
      var patch = {};
      patch[field] = want;
      var row = await DB.updateItem(item.id, patch);
      mergeItem(row);
      saveCache();
      renderAll();
      if (hadFocus) {   // the list was rebuilt: put keyboard focus back
        var again = $('list').querySelector('[data-fk="' + key + '"]');
        if (again) { again.focus({ preventScroll: true }); }
      }
      toast(want ? 'Alert marked as on' : 'Alert marked as off');
    } catch (e) {
      cb.checked = !want;
      cb.disabled = false;
      handleError(e, "Couldn't save the alert.");
    }
  }

  // ---------------------------------------------------------------------------
  // Loading from the server
  // ---------------------------------------------------------------------------
  async function refresh() {
    if (refreshing || !state.userId) { return; }
    refreshing = true;
    if (state.loaded && navigator.onLine === false) { setBanner('Offline, showing saved copy.'); }
    try {
      var results = await Promise.all([DB.listItems(), DB.getSettings()]);
      if (!state.userId) { return; }   // signed out while loading
      state.items = results[0];
      if (results[1]) { state.settings = results[1]; }
      state.loaded = true;
      state.loadError = '';
      state.lastRefresh = Date.now();
      setBanner('');
      saveCache();
      renderAll();
    } catch (e) {
      if (e && e.kind === 'auth') { leaveApp('Your session expired. Please sign in again.'); return; }
      if (!state.userId) { return; }
      if (state.loaded) {
        setBanner(e && e.kind === 'network' ?
          'Offline, showing saved copy.' :
          "Couldn't refresh (" + ((e && e.message) || 'unknown error') + "). Showing saved copy.");
      } else {
        state.loadError = (e && e.message) || "Couldn't load your list.";
      }
      renderAll();
    } finally {
      refreshing = false;
    }
  }

  function applyCache(c) {
    state.items = DB.sortItems(c.items);
    state.settings = c.settings || null;
    state.loaded = true;
  }

  async function enterApp(session) {
    var user = session && session.user;
    if (!user) { return; }
    if (state.userId === user.id) { return; }
    state.userId = user.id;
    state.email = str(user.email);
    showScreen('app');
    renderAll();
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Sign-in form
  // ---------------------------------------------------------------------------
  function wireLogin() {
    $('login-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var email = $('login-email').value.trim();
      var pw = $('login-password').value;
      var err = $('login-error');
      err.hidden = true;
      if (!email || !pw) {
        err.textContent = 'Enter your email and password.';
        err.hidden = false;
        (email ? $('login-password') : $('login-email')).focus();
        return;
      }
      var btn = $('login-submit');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        var session = await DB.signIn(email, pw);
        $('login-password').value = '';
        btn.disabled = false;
        btn.textContent = 'Sign in';
        await enterApp(session);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Sign in';
        $('login-password').select();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Confirm dialog
  // ---------------------------------------------------------------------------
  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      var dlg = $('confirm');
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = message;
      $('confirm-ok').textContent = okLabel || 'OK';
      dlg.returnValue = '';
      function done() {
        dlg.removeEventListener('close', done);
        resolve(dlg.returnValue === 'ok');
      }
      dlg.addEventListener('close', done);
      dlg.showModal();
      $('confirm-cancel').focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Editor
  // ---------------------------------------------------------------------------
  var editing = null;        // the item being edited, or null when adding
  var editorSnapshot = '';
  var editorBusy = false;

  var ERR_IDS = ['f-name', 'f-min', 'f-max', 'f-distance', 'f-target'];

  function setRadio(form, name, value) {
    var inputs = form.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < inputs.length; i++) { inputs[i].checked = inputs[i].value === value; }
  }
  function getRadio(form, name) {
    var el = form.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function numToInput(v) {
    var n = num(v);
    return n === null ? '' : String(Math.round(n * 100) / 100);
  }

  function fillCategoryList() {
    var dl = $('category-options');
    clear(dl);
    var seen = {};
    var names = Object.keys(Links.CODES.ebay.categories || {}).concat(categoriesInUse());
    names.forEach(function (n) {
      var k = catKey(n);
      if (!k || seen[k]) { return; }
      seen[k] = true;
      var o = document.createElement('option');
      o.value = n;
      dl.appendChild(o);
    });
  }

  function editorRaw() {
    var form = $('editor-form');
    return {
      name: $('f-name').value,
      search_on: getRadio(form, 'search_on'),
      status: getRadio(form, 'status'),
      priority: getRadio(form, 'priority'),
      category: $('f-category').value,
      condition: getRadio(form, 'condition'),
      min: $('f-min').value,
      max: $('f-max').value,
      distance: $('f-distance').value,
      what: $('f-what').value,
      target: $('f-target').value,
      notes: $('f-notes').value,
      ebay_alert: $('f-ebay-alert').checked,
      fb_alert: $('f-fb-alert').checked
    };
  }

  function clearEditorErrors() {
    ERR_IDS.forEach(function (id) {
      $(id + '-err').textContent = '';
      $(id).removeAttribute('aria-invalid');
    });
    var e = $('editor-error');
    e.hidden = true;
    e.textContent = '';
  }

  function showFieldError(id, message) {
    $(id + '-err').textContent = message;
    $(id).setAttribute('aria-invalid', 'true');
  }

  // Money: blank -> null; otherwise a number >= 0 with at most 2 decimals.
  function parseMoney(raw, errors, id, label) {
    var s = raw.trim().replace(/[$,\s]/g, '');
    if (s === '') { return null; }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) { errors[id] = label + ' must be a number, 0 or more.'; return null; }
    var n = Math.round(Number(s) * 100) / 100;
    if (!isFinite(n) || n < 0) { errors[id] = label + ' must be a number, 0 or more.'; return null; }
    if (n > 99999999.99) { errors[id] = label + ' is too large.'; return null; }
    return n;
  }

  function readEditor() {
    var r = editorRaw();
    var errors = {};
    var name = r.name.trim();
    if (!name) { errors['f-name'] = 'Enter a name.'; }

    var min = parseMoney(r.min, errors, 'f-min', 'Min price');
    var max = parseMoney(r.max, errors, 'f-max', 'Max price');
    var target = parseMoney(r.target, errors, 'f-target', 'Target');
    if (min !== null && max !== null && min > max && !errors['f-min'] && !errors['f-max']) {
      errors['f-max'] = 'Max price must be at least the min price.';
    }

    var distance = null;
    var ds = r.distance.trim();
    if (ds !== '') {
      if (!/^\d+$/.test(ds) || Number(ds) < 1 || Number(ds) > 20000) {
        errors['f-distance'] = 'Use a whole number of miles, 1 or more (or leave blank for your default radius).';
      } else {
        distance = Number(ds);
      }
    }

    function text(v) { var t = v.trim(); return t === '' ? null : t; }

    return {
      errors: errors,
      fields: {
        name: name,
        search_on: oneOf(r.search_on, SEARCH_ON, 'both'),
        status: oneOf(r.status, STATUSES, 'hunting'),
        priority: oneOf(r.priority, PRIORITIES, 'normal'),
        category: text(r.category),
        condition: oneOf(r.condition, CONDITIONS, 'any'),
        min_price: min,
        max_price: max,
        distance_mi: distance,
        what_counts: text(r.what),
        my_target: target,
        my_notes: text(r.notes),
        ebay_alert: !!r.ebay_alert,
        fb_alert: !!r.fb_alert
      }
    };
  }

  function sameValue(a, b) {
    if (a === '' || a === undefined) { a = null; }
    if (b === '' || b === undefined) { b = null; }
    if (typeof a === 'boolean' || typeof b === 'boolean') { return !!a === !!b; }
    if (a === null || b === null) { return a === b; }
    if (typeof a === 'number' || typeof b === 'number') { return Number(a) === Number(b); }
    return String(a) === String(b);
  }

  function researchRows(item) {
    function m(v) { var n = num(v); return n === null ? '—' : money(n); }
    function t(v) { return nonEmpty(v) ? str(v) : '—'; }
    var low = num(item.sold_low), high = num(item.sold_high);
    return [
      ['Suggested target', m(item.suggested_target)],
      ['Usual price', m(item.usual_price)],
      ['Sold range', low === null && high === null ? '—' : (low === null ? '?' : money(low)) + '–' + (high === null ? '?' : money(high))],
      ['Sales found', num(item.sales_found) === null ? '—' : String(num(item.sales_found))],
      ['Confidence', t(item.confidence)],
      ['Researched by', t(item.researched_by)],
      ['Researched on', fmtDate(item.researched_at) || '—'],
      ['Notes', t(item.research_notes)]
    ];
  }

  function openEditor(item) {
    editing = item || null;
    editorBusy = false;
    var form = $('editor-form');
    var it = item || {
      name: '', search_on: 'both', status: 'hunting', priority: 'normal', category: '', condition: 'any',
      min_price: null, max_price: null, distance_mi: null, what_counts: '', my_target: null, my_notes: '',
      ebay_alert: false, fb_alert: false
    };

    $('editor-title').textContent = item ? 'Edit item' : 'Add item';
    fillCategoryList();
    $('f-name').value = str(it.name);
    setRadio(form, 'search_on', oneOf(it.search_on, SEARCH_ON, 'both'));
    setRadio(form, 'status', oneOf(it.status, STATUSES, 'hunting'));
    setRadio(form, 'priority', oneOf(it.priority, PRIORITIES, 'normal'));
    $('f-category').value = str(it.category);
    setRadio(form, 'condition', oneOf(it.condition, CONDITIONS, 'any'));
    $('f-min').value = numToInput(it.min_price);
    $('f-max').value = numToInput(it.max_price);
    $('f-distance').value = num(it.distance_mi) === null ? '' : String(num(it.distance_mi));
    $('f-what').value = str(it.what_counts);
    $('f-target').value = numToInput(it.my_target);
    $('f-notes').value = str(it.my_notes);
    $('f-ebay-alert').checked = !!it.ebay_alert;
    $('f-fb-alert').checked = !!it.fb_alert;

    var research = $('editor-research');
    research.hidden = !item;
    research.open = false;
    var body = $('editor-research-body');
    clear(body);
    if (item) { body.appendChild(facts(researchRows(item))); }

    $('editor-delete').hidden = !item;
    $('editor-save').disabled = false;
    $('editor-save').textContent = 'Save';
    clearEditorErrors();

    var dlg = $('editor');
    dlg.showModal();
    syncModalClass();
    $('editor').querySelector('.sheet-scroll').scrollTop = 0;
    editorSnapshot = JSON.stringify(editorRaw());
    if (!item) { $('f-name').focus(); }
  }

  function closeEditor() {
    var dlg = $('editor');
    if (dlg.open) { dlg.close(); }
    editing = null;
  }

  async function cancelEditor() {
    if (editorBusy) { return; }
    var dirty = JSON.stringify(editorRaw()) !== editorSnapshot;
    if (dirty) {
      var discard = await confirmDialog('Discard changes?', 'Your edits to this item have not been saved.', 'Discard');
      if (!discard) { return; }
    }
    closeEditor();
  }

  async function saveEditor(ev) {
    ev.preventDefault();
    if (editorBusy) { return; }
    clearEditorErrors();
    var r = readEditor();
    var firstBad = ERR_IDS.filter(function (id) { return r.errors[id]; })[0];
    if (firstBad) {
      ERR_IDS.forEach(function (id) { if (r.errors[id]) { showFieldError(id, r.errors[id]); } });
      $(firstBad).focus();
      return;
    }

    // When editing, send only what changed so nothing else gets overwritten.
    var fields = r.fields;
    if (editing) {
      var changed = {};
      Object.keys(fields).forEach(function (k) {
        if (!sameValue(fields[k], editing[k])) { changed[k] = fields[k]; }
      });
      if (Object.keys(changed).length === 0) { closeEditor(); toast('No changes'); return; }
      fields = changed;
    }

    editorBusy = true;
    var saveBtn = $('editor-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      var row = editing ? await DB.updateItem(editing.id, fields) : await DB.addItem(fields);
      var wasNew = !editing;
      mergeItem(row);
      saveCache();
      editorBusy = false;
      closeEditor();
      state.expandedId = matchesFilters(row) ? String(row.id) : state.expandedId;
      renderAll();
      var li = $('list').querySelector('[data-id="' + String(row.id).replace(/"/g, '') + '"]');
      if (li) {
        li.scrollIntoView({ block: 'nearest' });
        var rb = li.querySelector('.row');
        if (rb) { rb.focus({ preventScroll: true }); }
        toast(wasNew ? 'Item added' : 'Item saved');
      } else {
        toast((wasNew ? 'Item added' : 'Item saved') + ', but the current filters hide it');
      }
    } catch (e) {
      editorBusy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      if (e && e.kind === 'auth') { leaveApp('Your session expired. Please sign in again.'); return; }
      var box = $('editor-error');
      box.textContent = (e && e.message) || "Couldn't save.";
      box.hidden = false;
    }
  }

  async function deleteFromEditor() {
    if (!editing || editorBusy) { return; }
    var item = editing;
    var ok = await confirmDialog('Delete this item?',
      '“' + (str(item.name) || '(no name)') + '” (#' + item.id + ') will be deleted for good.', 'Delete');
    if (!ok) { return; }
    editorBusy = true;
    $('editor-delete').disabled = true;
    try {
      await DB.deleteItem(item.id);
      removeItem(item.id);
      saveCache();
      editorBusy = false;
      closeEditor();
      renderAll();
      toast('Item deleted');
    } catch (e) {
      editorBusy = false;
      if (e && e.kind === 'auth') { leaveApp('Your session expired. Please sign in again.'); return; }
      var box = $('editor-error');
      box.textContent = (e && e.message) || "Couldn't delete.";
      box.hidden = false;
    } finally {
      $('editor-delete').disabled = false;
    }
  }

  function wireEditor() {
    $('editor-form').addEventListener('submit', saveEditor);
    // Typing in a field clears that field's error message.
    $('editor-form').addEventListener('input', function (ev) {
      var id = ev.target && ev.target.id;
      if (ERR_IDS.indexOf(id) !== -1) {
        $(id + '-err').textContent = '';
        ev.target.removeAttribute('aria-invalid');
      }
    });
    $('editor-cancel').addEventListener('click', cancelEditor);
    $('editor-x').addEventListener('click', cancelEditor);
    $('editor-delete').addEventListener('click', deleteFromEditor);
    $('editor').addEventListener('cancel', function (ev) { ev.preventDefault(); cancelEditor(); });
    $('editor').addEventListener('close', syncModalClass);
    $('fab').addEventListener('click', function () { openEditor(null); });
  }

  // ---------------------------------------------------------------------------
  // Settings sheet
  // ---------------------------------------------------------------------------
  function openSettings() {
    var s = state.settings || {};
    $('s-zip').value = str(s.home_zip);
    $('s-fbloc').value = str(s.fb_location_id);
    $('s-radius').value = num(s.default_fb_radius_mi) === null ? '' : String(num(s.default_fb_radius_mi));
    $('s-zip-err').textContent = '';
    $('s-radius-err').textContent = '';
    $('s-zip').removeAttribute('aria-invalid');
    $('s-radius').removeAttribute('aria-invalid');
    var e = $('settings-error');
    e.hidden = true;
    e.textContent = '';
    $('settings-save').disabled = false;
    $('settings-save').textContent = 'Save settings';

    $('pw-new').value = '';
    $('pw-again').value = '';
    var pm = $('pw-msg');
    pm.hidden = true;
    pm.textContent = '';
    $('signed-in-as').textContent = state.email ? 'Signed in as ' + state.email : '';

    $('settings').showModal();
    syncModalClass();
    $('settings').querySelector('.sheet-scroll').scrollTop = 0;
  }

  async function saveSettingsForm(ev) {
    ev.preventDefault();
    var zipEl = $('s-zip'), radEl = $('s-radius');
    var zipErr = $('s-zip-err'), radErr = $('s-radius-err');
    var box = $('settings-error');
    zipErr.textContent = ''; radErr.textContent = '';
    zipEl.removeAttribute('aria-invalid'); radEl.removeAttribute('aria-invalid');
    box.hidden = true;

    var zip = zipEl.value.trim();
    var bad = null;
    if (zip !== '' && !/^\d{5}$/.test(zip)) {
      zipErr.textContent = 'Use exactly 5 digits, or leave blank.';
      zipEl.setAttribute('aria-invalid', 'true');
      bad = zipEl;
    }
    var rs = radEl.value.trim();
    var radius = null;
    if (!/^\d+$/.test(rs) || Number(rs) < 1 || Number(rs) > 100000) {
      radErr.textContent = 'Enter a whole number of miles, 1 or more.';
      radEl.setAttribute('aria-invalid', 'true');
      bad = bad || radEl;
    } else {
      radius = Number(rs);
    }
    if (bad) { bad.focus(); return; }

    var loc = $('s-fbloc').value.trim();
    var m = loc.match(/marketplace\/([^\/?#\s]+)/i);   // forgive a pasted full address
    if (m) { loc = m[1]; }

    var btn = $('settings-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      var row = await DB.saveSettings({
        home_zip: zip === '' ? null : zip,
        fb_location_id: loc === '' ? null : loc,
        default_fb_radius_mi: radius
      });
      state.settings = row;
      saveCache();
      renderList();
      $('settings').close();
      toast('Settings saved');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Save settings';
      if (e && e.kind === 'auth') { leaveApp('Your session expired. Please sign in again.'); return; }
      box.textContent = e.message;
      box.hidden = false;
    }
  }

  async function changePasswordForm(ev) {
    ev.preventDefault();
    var msg = $('pw-msg');
    function say(text, ok) {
      msg.textContent = text;
      msg.className = ok ? 'form-ok' : 'form-error';
      msg.hidden = false;
    }
    var a = $('pw-new').value;
    var b = $('pw-again').value;
    if (a.length < 8) { say('Use at least 8 characters.'); $('pw-new').focus(); return; }
    if (a !== b) { say("The two passwords don't match."); $('pw-again').focus(); return; }
    var btn = $('pw-save');
    btn.disabled = true;
    try {
      await DB.changePassword(a);
      $('pw-new').value = '';
      $('pw-again').value = '';
      say('Password changed.', true);
    } catch (e) {
      if (e && e.kind === 'auth') { leaveApp('Your session expired. Please sign in again.'); return; }
      say(e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function signOutNow() {
    var btn = $('btn-signout');
    btn.disabled = true;
    try {
      await DB.signOut();
      leaveApp('');
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  function wireSettings() {
    $('btn-settings').addEventListener('click', openSettings);
    $('settings-x').addEventListener('click', function () { $('settings').close(); });
    $('settings').addEventListener('close', syncModalClass);
    $('settings-form').addEventListener('submit', saveSettingsForm);
    $('settings-form').addEventListener('input', function (ev) {
      var id = ev.target && ev.target.id;
      if (id === 's-zip' || id === 's-radius') {
        $(id + '-err').textContent = '';
        ev.target.removeAttribute('aria-invalid');
      }
    });
    $('pw-form').addEventListener('submit', changePasswordForm);
    $('btn-signout').addEventListener('click', signOutNow);
    $('confirm').addEventListener('close', syncModalClass);
  }

  // ---------------------------------------------------------------------------
  // Filters + list wiring
  // ---------------------------------------------------------------------------
  function wireList() {
    $('chips').addEventListener('click', function (ev) {
      var chip = ev.target.closest ? ev.target.closest('.chip') : null;
      if (!chip) { return; }
      if (chip.dataset.status) {
        state.status = oneOf(chip.dataset.status, STATUSES.concat(['all']), 'hunting');
      } else if (TOGGLES.indexOf(chip.dataset.toggle) !== -1) {
        state[chip.dataset.toggle] = !state[chip.dataset.toggle];
      }
      renderAll();
    });

    $('category-filter').addEventListener('change', function (ev) {
      state.category = ev.target.value;
      renderList();
    });

    $('search').addEventListener('input', function (ev) {
      state.query = ev.target.value;
      renderList();
    });

    $('list').addEventListener('click', function (ev) {
      var row = ev.target.closest ? ev.target.closest('.row') : null;
      if (!row) { return; }
      var li = row.parentNode;
      if (li && li.dataset.id) { toggleExpand(li.dataset.id); }
    });

    $('banner-retry').addEventListener('click', function () { refresh(); });
  }

  // ---------------------------------------------------------------------------
  // Auth events + start-up
  // ---------------------------------------------------------------------------
  function onAuthEvent(event, session) {
    if (event === 'SIGNED_OUT') {
      if (state.userId) { leaveApp(''); }
    } else if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
      enterApp(session);
    }
  }

  async function start() {
    try { localStorage.removeItem(LEGACY_MODE_KEY); } catch (e) { /* ignore */ }
    $('boot-reload').addEventListener('click', function () { location.reload(); });

    if (!DB || !Links) {
      bootError('The app could not start (a script failed to load). Check your connection and reload.');
      return;
    }
    wireLogin();
    wireList();
    wireEditor();
    wireSettings();

    if (window.ResizeObserver) {
      new ResizeObserver(measureHeader).observe($('topbar'));
    }
    window.addEventListener('online', function () { refresh(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && state.userId && Date.now() - state.lastRefresh > REFRESH_AFTER_MS) {
        refresh();
      }
    });

    try {
      DB.init();
    } catch (e) {
      bootError(e.message);
      return;
    }
    // Deferred: supabase-js can deadlock if you call back into it from inside the callback.
    DB.onAuthChange(function (event, session) {
      setTimeout(function () { onAuthEvent(event, session); }, 0);
    });

    // Instant load: draw the saved copy before asking the server anything.
    var cache = loadCache();
    var optimistic = !!(cache && DB.hasStoredSession());
    if (optimistic) {
      applyCache(cache);
      showScreen('app');
      renderAll();
    }

    var res = await DB.getSession();
    if (res.session) {
      await enterApp(res.session);
    } else if (optimistic && res.error && res.error.kind === 'network') {
      // Offline with an expired token: keep showing the saved copy.
      state.userId = 'offline';
      setBanner('Offline, showing saved copy.');
    } else {
      leaveApp('');
    }
  }

  start();
})();
