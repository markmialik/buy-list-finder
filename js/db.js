/*
 * db.js - Buy List Finder data layer.
 *
 * A thin wrapper around supabase-js (v2, UMD global `supabase`).
 * Attaches one global: BuyDB.
 *
 * Rules:
 *  - addItem / updateItem send ONLY the owner-edited columns. The agent-written
 *    columns (suggested_target, usual_price, sold_*, sales_found, confidence,
 *    research_*, researched_*) are never sent, so research an agent writes at
 *    the same moment is never overwritten.
 *  - Every method rejects with an Error whose .message is readable by a person
 *    and whose .kind is 'network' | 'auth' | 'credentials' | 'other'.
 */
(function (root) {
  'use strict';

  // Fixed storage key so the page can tell (synchronously) whether a session
  // is probably stored before supabase-js has finished starting.
  var STORAGE_KEY = 'blf-auth';

  var OWNER_ITEM_FIELDS = [
    'name', 'search_on', 'status', 'priority',
    'category', 'condition', 'min_price', 'max_price', 'distance_mi',
    'what_counts', 'ebay_alert', 'fb_alert', 'my_target', 'my_notes'
  ];
  var SETTINGS_FIELDS = ['home_zip', 'fb_location_id', 'default_fb_radius_mi'];
  var PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
  var PAGE_SIZE = 1000;

  var client = null;

  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------
  function makeError(message, kind, cause) {
    var e = new Error(message);
    e.kind = kind || 'other';
    e.cause = cause;
    return e;
  }

  // Turn whatever supabase-js / fetch threw into an Error with a plain message.
  function toError(err, fallback) {
    if (err && err.kind && err instanceof Error) { return err; }   // already ours
    var raw = (err && err.message) ? String(err.message) : '';
    var name = (err && err.name) ? String(err.name) : '';
    var status = err && err.status;
    var code = err && err.code ? String(err.code) : '';

    if (name === 'AuthRetryableFetchError' ||
        /failed to fetch|networkerror|load failed|network request failed|fetch failed|network connection was lost|internet connection appears to be offline/i.test(raw)) {
      return makeError("Can't reach the server. Check your connection and try again.", 'network', err);
    }
    if (/invalid login credentials/i.test(raw)) {
      return makeError('Wrong email or password.', 'credentials', err);
    }
    if (/email not confirmed/i.test(raw)) {
      return makeError("This email address isn't confirmed yet.", 'credentials', err);
    }
    if (status === 429 || /rate limit|too many requests|over_request_rate_limit/i.test(raw)) {
      return makeError('Too many attempts. Wait a minute and try again.', 'other', err);
    }
    if (/different from the old password/i.test(raw)) {
      return makeError('The new password must be different from the current one.', 'other', err);
    }
    if (/price_range/i.test(raw)) {
      return makeError("Min price can't be higher than max price.", 'other', err);
    }
    if (name === 'AuthSessionMissingError' || status === 401 || code === 'PGRST301' ||
        code === 'PGRST303' || /\bjwt\b|invalid refresh token|refresh token not found|session missing|auth session missing/i.test(raw)) {
      return makeError('Your session has expired. Please sign in again.', 'auth', err);
    }
    if (code === '42501' || status === 403 || /row-level security|permission denied/i.test(raw)) {
      return makeError("This account isn't allowed to do that.", 'other', err);
    }
    return makeError(raw || fallback || 'Something went wrong. Please try again.', 'other', err);
  }

  // Await a supabase-js call and throw a readable Error on any failure.
  async function run(call, fallback) {
    var res;
    try {
      res = await call;
    } catch (e) {
      throw toError(e, fallback);
    }
    if (res && res.error) { throw toError(res.error, fallback); }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Setup + auth
  // ---------------------------------------------------------------------------
  function init() {
    if (client) { return client; }
    var cfg = root.BUY_LIST_CONFIG;
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey) {
      throw makeError('The app is missing its server settings (js/config.js).', 'other');
    }
    if (!root.supabase || typeof root.supabase.createClient !== 'function') {
      throw makeError("The sign-in library didn't load. Check your connection and reload.", 'network');
    }
    client = root.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: STORAGE_KEY
      }
    });
    return client;
  }

  function need() {
    if (!client) { init(); }
    return client;
  }

  // Synchronous hint only; getSession() is the real answer.
  function hasStoredSession() {
    try { return !!root.localStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
  }

  // Resolves to { session, error } and never rejects. error is set only when
  // the session could not be determined (for example offline with an expired
  // token), as opposed to "there is simply no session".
  async function getSession() {
    try {
      var res = await need().auth.getSession();
      if (res.error) { return { session: res.data && res.data.session || null, error: toError(res.error) }; }
      return { session: res.data.session || null, error: null };
    } catch (e) {
      return { session: null, error: toError(e) };
    }
  }

  async function signIn(email, password) {
    var res = await run(need().auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') }),
      "Couldn't sign in.");
    return res.data.session;
  }

  // Signs out this device only (other devices stay signed in) and works offline.
  async function signOut() {
    var res;
    try { res = await need().auth.signOut({ scope: 'local' }); } catch (e) { res = { error: e }; }
    if (res && res.error) { throw toError(res.error, "Couldn't sign out."); }
  }

  async function changePassword(newPw) {
    if (typeof newPw !== 'string' || newPw.length < 8) {
      throw makeError('Use at least 8 characters for the password.', 'other');
    }
    await run(need().auth.updateUser({ password: newPw }), "Couldn't change the password.");
  }

  // cb(event, session). Returns an unsubscribe function.
  function onAuthChange(cb) {
    var res = need().auth.onAuthStateChange(function (event, session) { cb(event, session); });
    var sub = res && res.data && res.data.subscription;
    return function () { if (sub) { sub.unsubscribe(); } };
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------
  function pickOwnerFields(fields) {
    var out = {};
    if (!fields) { return out; }
    for (var i = 0; i < OWNER_ITEM_FIELDS.length; i++) {
      var k = OWNER_ITEM_FIELDS[i];
      if (Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== undefined) { out[k] = fields[k]; }
    }
    return out;
  }

  function sortItems(items) {
    return items.slice().sort(function (a, b) {
      var ra = PRIORITY_RANK[a.priority]; if (ra === undefined) { ra = 1; }
      var rb = PRIORITY_RANK[b.priority]; if (rb === undefined) { rb = 1; }
      if (ra !== rb) { return ra - rb; }
      var c = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true });
      return c !== 0 ? c : (a.id - b.id);
    });
  }

  // All items, ordered high/normal/low priority, then name.
  async function listItems() {
    var c = need();
    var all = [];
    var from = 0;
    for (;;) {
      var res = await run(c.from('items').select('*').order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1),
        "Couldn't load your list.");
      var rows = res.data || [];
      all = all.concat(rows);
      if (rows.length < PAGE_SIZE) { break; }
      from += PAGE_SIZE;
    }
    return sortItems(all);
  }

  async function addItem(fields) {
    var f = pickOwnerFields(fields);
    if (typeof f.name !== 'string' || f.name.trim() === '') {
      throw makeError('Give the item a name.', 'other');
    }
    var res = await run(need().from('items').insert(f).select().single(), "Couldn't add the item.");
    return res.data;
  }

  async function updateItem(id, fields) {
    var f = pickOwnerFields(fields);
    if (id === null || id === undefined || id === '') { throw makeError('Missing item id.', 'other'); }
    if (Object.keys(f).length === 0) { throw makeError('Nothing to save.', 'other'); }
    if (Object.prototype.hasOwnProperty.call(f, 'name') && (typeof f.name !== 'string' || f.name.trim() === '')) {
      throw makeError('Give the item a name.', 'other');
    }
    var res = await run(need().from('items').update(f).eq('id', id).select(), "Couldn't save the item.");
    if (!res.data || res.data.length !== 1) {
      throw makeError("That item wasn't found. It may have been deleted. Pull to refresh.", 'other');
    }
    return res.data[0];
  }

  async function deleteItem(id) {
    if (id === null || id === undefined || id === '') { throw makeError('Missing item id.', 'other'); }
    var res = await run(need().from('items').delete().eq('id', id).select('id'), "Couldn't delete the item.");
    if (!res.data || res.data.length !== 1) {
      throw makeError("That item wasn't found. It may already be deleted.", 'other');
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Settings (single row, id = 1)
  // ---------------------------------------------------------------------------
  async function getSettings() {
    var res = await run(need().from('settings').select('*').eq('id', 1).maybeSingle(), "Couldn't load settings.");
    return res.data || null;
  }

  async function saveSettings(s) {
    var f = {};
    for (var i = 0; i < SETTINGS_FIELDS.length; i++) {
      var k = SETTINGS_FIELDS[i];
      if (s && Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) { f[k] = s[k]; }
    }
    if (Object.keys(f).length === 0) { throw makeError('Nothing to save.', 'other'); }
    var res = await run(need().from('settings').update(f).eq('id', 1).select(), "Couldn't save settings.");
    if (!res.data || res.data.length !== 1) {
      throw makeError("Settings weren't saved (no settings row found for this account).", 'other');
    }
    return res.data[0];
  }

  root.BuyDB = {
    init: init,
    hasStoredSession: hasStoredSession,
    getSession: getSession,
    signIn: signIn,
    signOut: signOut,
    changePassword: changePassword,
    onAuthChange: onAuthChange,
    listItems: listItems,
    getSettings: getSettings,
    saveSettings: saveSettings,
    addItem: addItem,
    updateItem: updateItem,
    deleteItem: deleteItem,
    sortItems: sortItems,
    OWNER_ITEM_FIELDS: OWNER_ITEM_FIELDS.slice()
  };
})(window);
