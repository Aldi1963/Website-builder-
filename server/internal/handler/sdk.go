package handler

// SDK klien yang ditanam ke setiap proyek hasil AI.
//
// Kontrak: aplikasi harus tetap berjalan TANPA bantuan parent/iframe. Sebelumnya
// window.cloudAuth/cloudDb hanya ada saat Builder menyuntikkannya ke iframe,
// sehingga membuka runtime/publish langsung membuat aplikasi crash.
//
// Catatan implementasi: sumber JS sengaja memakai string concatenation, bukan
// template literal, karena berada di dalam Go raw string (tanpa backtick).

const projectSDKSource = `/* WebBuilder Cloud SDK — dibuat otomatis, jangan diedit manual. */
(function () {
  var PID = "__PID__";
  var SESSION_KEY = "wb_project_session_" + PID;

  function apiBase() {
    return typeof window.__WB_API_BASE__ === "string" ? window.__WB_API_BASE__ : "";
  }
  function token() {
    try { return localStorage.getItem(SESSION_KEY) || ""; } catch (e) { return ""; }
  }
  function saveToken(d) {
    try { if (d && d.token) localStorage.setItem(SESSION_KEY, d.token); } catch (e) {}
    return d;
  }
  async function request(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var tk = token();
    if (tk) headers["X-Project-Session"] = tk;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    var res = await fetch(apiBase() + "/api/app-api/" + PID + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && (data.error || data.message)) || ("HTTP " + res.status));
    return data;
  }

  var cloudAuth = {
    register: function (a, b, c) {
      var name, email, password;
      if (a && typeof a === "object") { name = a.name; email = a.email; password = a.password; }
      else { name = a; email = b; password = c; }
      return request("/auth/register", { method: "POST", body: { name: name, email: email, password: password } }).then(saveToken);
    },
    login: function (a, b) {
      var email, password;
      if (a && typeof a === "object") { email = a.email; password = a.password; }
      else { email = a; password = b; }
      return request("/auth/login", { method: "POST", body: { email: email, password: password } }).then(saveToken);
    },
    me: function () {
      if (!token()) return Promise.reject(new Error("Belum login"));
      return request("/auth/me").then(function (d) { return d && d.user ? d.user : d; });
    },
    session: function () { return token(); },
    logout: function () {
      return request("/auth/logout", { method: "POST" }).catch(function () {}).then(function () {
        try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
      });
    }
  };

  var cloudDb = {
    _call: function (act, payload) {
      return request("/db/" + act, { method: "POST", body: payload });
    },
    select: function (table, where, opts) {
      var payload = Object.assign({ table: table, where: where || {} }, opts || {});
      return this._call("select", payload).then(function (d) { return d && d.data ? d.data : []; });
    },
    insert: function (table, data) { return this._call("insert", { table: table, data: data }); },
    update: function (table, where, data) { return this._call("update", { table: table, where: where, data: data }); },
    delete: function (table, where) { return this._call("delete", { table: table, where: where }); },
    query: function (sql, args) { return this._call("query", { sql: sql, args: args || [] }); }
  };
  cloudDb.del = cloudDb.delete;

  var localDb = {
    get: function (k) {
      try { var v = localStorage.getItem("wb_db_" + PID + "_" + k); return Promise.resolve(v ? JSON.parse(v) : null); }
      catch (e) { return Promise.resolve(null); }
    },
    set: function (k, v) {
      try { localStorage.setItem("wb_db_" + PID + "_" + k, JSON.stringify(v)); } catch (e) {}
      return Promise.resolve();
    },
    del: function (k) {
      try { localStorage.removeItem("wb_db_" + PID + "_" + k); } catch (e) {}
      return Promise.resolve();
    },
    list: function () {
      var keys = [];
      try {
        var prefix = "wb_db_" + PID + "_";
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(prefix) === 0) keys.push(k.slice(prefix.length));
        }
      } catch (e) {}
      return Promise.resolve(keys);
    }
  };

  window.cloudAuth = window.cloudAuth || cloudAuth;
  window.cloudDb = window.cloudDb || cloudDb;
  window.db = window.db || localDb;
})();
`

const projectSDKTypes = `// Deklarasi global WebBuilder Cloud SDK (dibuat otomatis).
export {};

declare global {
  interface Window {
    __WB_API_BASE__?: string;
    cloudAuth: {
      register(input: { name?: string; email: string; password: string } | string, email?: string, password?: string): Promise<unknown>;
      login(input: { email: string; password: string } | string, password?: string): Promise<unknown>;
      me(): Promise<{ id?: number; name?: string; email?: string; role?: string }>;
      session(): string;
      logout(): Promise<void>;
    };
    cloudDb: {
      select(table: string, where?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<any[]>;
      insert(table: string, data: Record<string, unknown>): Promise<unknown>;
      update(table: string, where: Record<string, unknown>, data: Record<string, unknown>): Promise<unknown>;
      delete(table: string, where: Record<string, unknown>): Promise<unknown>;
      del(table: string, where: Record<string, unknown>): Promise<unknown>;
      query(sql: string, args?: unknown[]): Promise<unknown>;
    };
    db: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
      del(key: string): Promise<void>;
      list(): Promise<string[]>;
    };
  }
}
`
