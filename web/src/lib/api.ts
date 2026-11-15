export const API = "";
export function getToken() { return localStorage.getItem("wb-token") || ""; }
export function setToken(t: string) { localStorage.setItem("wb-token", t); }
export function jwtPayload(): any {
  try {
    const t = getToken().split(".")[1];
    return JSON.parse(atob(t.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
}

async function req(path: string, opts: any = {}) {
  const r = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken(), ...(opts.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || "Gagal");
  return d;
}

export const api = {
  register: (name: string, email: string, password: string) => req("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) }),
  login: (email: string, password: string) => req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => req("/me"),
  projects: () => req("/projects"),
  createProject: (name: string, framework: string) => req("/projects", { method: "POST", body: JSON.stringify({ name, framework }) }),
  getProject: (id: string) => req("/projects/" + id),
};
