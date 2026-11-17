const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
const server = http.createServer(app);

// ================== Seguridad: que no tiren el servidor ni lo llenen de bots ==================
// IP real de quien se conecta. Render tiene Cloudflare adelante, que manda True-Client-IP (no se puede falsificar).
// X-Forwarded-For SÍ se puede falsificar (Render solo le agrega al final), así que de ahí se usa el último valor.
// IP real del visitante. OJO: solo confiamos en la cabecera que pone NUESTRO proxy, nunca en una
// que mande el cliente (si no, cualquiera manda "true-client-ip: loquesea" y se hace pasar por mil IPs
// distintas, salteando topes, flood-ban y baneos). En Render (nube gris de Cloudflare) la IP real es
// la última de x-forwarded-for, que la agrega Render. Si algún día ponés la nube naranja de Cloudflare,
// configurá la variable TRUST_IP_HEADER=cf-connecting-ip en Render.
const TRUST_IP_HEADER = (process.env.TRUST_IP_HEADER || "").toLowerCase().trim();
function realIp(headers = {}, fallback = "") {
  const h = (k) => String(headers[k] || "").trim();
  if (TRUST_IP_HEADER) return (h(TRUST_IP_HEADER) || fallback || "").slice(0, 64);
  const xff = h("x-forwarded-for").split(",").map((x) => x.trim()).filter(Boolean);
  return (xff[xff.length - 1] || fallback || "").slice(0, 64);
}
const SEC = {
  maxConnPerIp: parseInt(process.env.MAX_CONN_PER_IP) || 20,   // conexiones abiertas a la vez desde una misma IP
  maxNewConnPerMin: 40,                                          // conexiones nuevas por minuto por IP
  maxJoinsPerMin: 8,                                             // apodos nuevos por minuto por IP
  maxTotalConn: parseInt(process.env.MAX_CONN) || 400,           // tope total (para no quedarse sin memoria)
  httpPerMin: 400,                                               // pedidos web por minuto por IP
};
const connCount = new Map();       // ip -> conexiones abiertas
const hits = new Map();            // "tipo:ip" -> [tiempos]
const floodBans = new Map();       // ip -> hasta cuándo (bloqueo automático por abuso)
const secLog = new Map();          // para no llenar los registros con el mismo aviso
function tooMany(kind, ip, max, windowMs = 60000) {
  const k = kind + ":" + ip, t = Date.now();
  const arr = (hits.get(k) || []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(k, arr);
  return arr.length > max;
}
function floodBan(ip, mins, why) {
  if (!ip) return;
  floodBans.set(ip, Date.now() + mins * 60000);
  if (!secLog.has(ip + why)) { secLog.set(ip + why, 1); console.warn(`🛡️ Bloqueo automático ${mins} min a ${ip}: ${why}`); setTimeout(() => secLog.delete(ip + why), 600000); }
  for (const s of io.sockets.sockets.values()) if (s.data.ip === ip) s.disconnect(true);
}
// Verificación anti-bots opcional con Cloudflare Turnstile (gratis). Se activa cargando las dos claves en Render.
const TURNSTILE_SITE = (process.env.TURNSTILE_SITE_KEY || "").trim();
const TURNSTILE_SECRET = TURNSTILE_SITE ? (process.env.TURNSTILE_SECRET_KEY || "").trim() : "";
async function verifyHuman(token, ip) {
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token || "").slice(0, 2048), remoteip: ip || "" });
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const j = await r.json();
    if (!j.success) console.warn("Turnstile rechazó:", (j["error-codes"] || []).join(","));
    return !!j.success;
  } catch (e) { console.error("Turnstile:", e.message); return true; } // si Cloudflare no responde, no dejamos a nadie afuera
}
// "Pase" firmado: quien ya se verificó no lo vuelve a hacer por 3 días en ese celu (aunque se reinicie el servidor)
const PASS_DAYS = 3;
const passSig = (dev, exp) => require("crypto").createHmac("sha256", TURNSTILE_SECRET).update(dev + "|" + exp).digest("base64url").slice(0, 32);
const makePass = (dev) => { const exp = Date.now() + PASS_DAYS * 86400e3; return `${exp}.${passSig(dev, exp)}`; };
function passOk(dev, pass) {
  if (!TURNSTILE_SECRET || !dev || typeof pass !== "string") return false;
  const [exp, sig] = pass.split(".");
  if (!(+exp > Date.now()) || !sig) return false;
  const good = passSig(dev, exp);
  return sig.length === good.length && require("crypto").timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const isFloodBanned = (ip) => (floodBans.get(ip) || 0) > Date.now();
setInterval(() => { // limpieza para que estos mapas no crezcan sin fin
  const t = Date.now();
  for (const [k, arr] of hits) if (!arr.length || t - arr[arr.length - 1] > 120000) hits.delete(k);
  for (const [ip, u] of floodBans) if (u < t) floodBans.delete(ip);
}, 60000).unref();
// Límite de pedidos web (páginas, fotos, avatares)
app.use((req, res, next) => {
  const ip = realIp(req.headers, req.socket.remoteAddress);
  if (isFloodBanned(ip)) return res.status(429).send("Demasiados pedidos. Probá en unos minutos.");
  if (tooMany("http", ip, SEC.httpPerMin)) { if (tooMany("http429", ip, 2000, 300000)) floodBan(ip, 15, "pedidos web sin parar"); return res.status(429).send("Demasiados pedidos. Probá en unos minutos."); }
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" });
  next();
});

// pingTimeout largo: Chrome en el celu frena la página cuando la minimizás y así no se corta enseguida
const io = new Server(server, {
  maxHttpBufferSize: 4e6, // permite fotos de hasta ~2,5 MB
  pingInterval: 25000, pingTimeout: 60000,
  // Se filtra antes de abrir la conexión: IP bloqueada, demasiadas conexiones o demasiado seguido
  allowRequest: (req, cb) => {
    const ip = realIp(req.headers, req.socket?.remoteAddress);
    if (isFloodBanned(ip)) return cb("bloqueado", false);
    if (io.engine.clientsCount >= SEC.maxTotalConn) return cb("lleno", false);
    if ((connCount.get(ip) || 0) >= SEC.maxConnPerIp) return cb("demasiadas conexiones", false);
    // Tope de ráfaga: evita que muchas conexiones a la vez saltee el tope por IP (el contador real se suma recién al conectar)
    if (tooMany("connBurst", ip, SEC.maxConnPerIp, 3000)) { if (tooMany("connflood", ip, 200)) floodBan(ip, 15, "conexiones sin parar"); return cb("muy seguido", false); }
    if (tooMany("conn", ip, SEC.maxNewConnPerMin)) { if (tooMany("connflood", ip, 200)) floodBan(ip, 15, "conexiones sin parar"); return cb("muy seguido", false); }
    cb(null, true);
  },
});
// Límite de eventos por conexión (cubeta de fichas): frena a quien manda miles de cosas por segundo
const BUCKETS = {
  draw: { cap: 400, per: 150 },  // trazos de pizarra y dibujo: muchos y chiquitos
  rtc: { cap: 200, per: 60 },    // señales de voz/llamadas
  normal: { cap: 40, per: 8 },   // todo lo demás: mensajes, votos, reacciones...
};
const bucketOf = (ev) => (/^(pic-draw|pic-clear|board-)/.test(ev) ? "draw" : /^(rtc|voice-sig|call-sig|ice|offer|answer)/.test(ev) ? "rtc" : "normal");
function takeToken(socket, ev) {
  const kind = bucketOf(ev), cfg = BUCKETS[kind], t = Date.now();
  const b = (socket.data.buckets ||= {})[kind] ||= { n: cfg.cap, at: t };
  b.n = Math.min(cfg.cap, b.n + ((t - b.at) / 1000) * cfg.per); b.at = t;
  if (b.n >= 1) { b.n -= 1; return true; }
  if (t - (socket.data.strikeAt || 0) > 60000) { socket.data.strikes = 0; socket.data.strikeAt = t; }
  socket.data.strikes = (socket.data.strikes || 0) + 1;
  if (socket.data.strikes > 300) floodBan(socket.data.ip, 10, `flood de eventos (${ev})`);
  return false;
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "Public")));
app.get("/ping", (req, res) => res.send("ok"));
app.get("/avatar/:nick", (req, res) => {
  const t = byNick(req.params.nick);
  if (!t || !t.c.avatar) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=31536000, immutable").type(t.c.avatarType || "image/jpeg").send(t.c.avatar);
});
// Config pública para el navegador (la clave de GIPHY es pública por diseño)
// Servidores para las llamadas de voz. STUN gratis de Google; TURN opcional (mejora la conexión en datos móviles)
const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
if (process.env.TURN_URL) ICE_SERVERS.push({ urls: process.env.TURN_URL.split(",").map((x) => x.trim()), username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" });
app.get("/config", (req, res) => res.json({ giphyKey: process.env.GIPHY_API_KEY || "", ai: !!(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY), iceServers: ICE_SERVERS, turnstile: TURNSTILE_SECRET ? TURNSTILE_SITE : "" }));

// ================== Configuración ==================
const BOT = "Fastidio";
const CRUPIER = "Crupier";
const GAME_ROOMS = ["j-trivia", "j-ia", "j-fiesta", "j-duelos"]; // sub-salas de 🎮 Juegos
const isGameRoom = (r) => GAME_ROOMS.includes(r);
const ROOMS = ["general", ...GAME_ROOMS, "voz", "confesiones", "mods"]; // "mods" = sala privada de moderadores · "confesiones" = anónima
const lockedRooms = new Set();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim(); // clave del dueño (👑), se configura en Render
// Moderadores permanentes: en Render, MOD_KEYS = "Lucia:clave1,Pedro:clave2"
const modKeys = new Map(); // clave -> nombre del moderador
const envModKeys = new Set(); // las que vienen de MOD_KEYS en Render
String(process.env.MOD_KEYS || "").split(",").map((x) => x.trim()).filter(Boolean).forEach((pair) => {
  const i = pair.lastIndexOf(":"); if (i > 0) { modKeys.set(pair.slice(i + 1).trim(), pair.slice(0, i).trim()); envModKeys.add(pair.slice(i + 1).trim()); }
});
const genKey = () => Array.from({ length: 8 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 31)]).join("");
const MAX_MSG = 500;
const STATUSES = ["disponible", "hablar", "escucho", "ausente", "nomolestar"];
const REACTIONS = ["❤️", "🫂", "👍", "😂", "😢", "🔥", "💛"];
const RESERVED = ["anonimo", "vos", "fastidio", "guardian", "crupier", "admin", "administrador", "moderador", "mod", "sistema", "bot", "__general__"];

// Vacía: los insultos están permitidos. El admin puede sumar palabras con /filtro +palabra
let BAD_WORDS = [];
// Incitación a hacerse daño: cuenta doble
const HARM_WORDS = ["matate", "suicidate", "kys", "ojala te mueras", "ojala te murieras", "anda a morir", "cortate las venas"];
// Señales de crisis: el bot no bloquea, ofrece ayuda en privado
const CRISIS_RE = /(me quiero matar|quiero matarme|suicid|quitarme la vida|no quiero vivir|no quiero seguir viviendo|quiero morir|me quiero morir|quiero morirme|cortarme|lastimarme|hacerme dano|terminar con todo|no aguanto mas|desaparecer para siempre)/;

const HELP_TEXT =
  "💛 Si estás pasando un momento muy difícil, no estás solo/a. Podés llamar gratis:\n" +
  "• 0800-999-0091 — Línea Nacional de Salud Mental (24 h, todo el país)\n" +
  "• 135 (CABA y GBA) o (011) 5275-1135 — Centro de Asistencia al Suicida\n" +
  "• 0800-222-5462 — Salud Mental Provincia de Buenos Aires (24 h)\n" +
  "• 911 si hay una emergencia.\n" +
  "Y si querés, contá lo que te pasa acá: hay gente que escucha.";

// ================== Estado en memoria ==================
const clients = new Map(); // socket.id -> datos del usuario
const users = new Map();   // apodo en minúsculas -> socket.id
const bans = new Map();    // ip -> vencimiento (ms)
const reports = new Map(); // apodo minúsc -> Map(reportante -> ts)
const messages = new Map(); // id -> { chat, from, to, reactions: {emoji: Set} }
let pinned = "";
let slowMode = 0;
let msgCounter = 0;

const now = () => Date.now();
const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a")
    .replace(/@/g, "a").replace(/\$/g, "s").replace(/(.)\1{2,}/g, "$1$1");
const newId = () => (++msgCounter).toString(36) + Math.random().toString(36).slice(2, 6);
const byNick = (n) => { const id = users.get(String(n || "").toLowerCase()); return id ? { id, c: clients.get(id) } : null; };
// Bloqueo mutuo: si uno bloquea al otro, no se leen. No aplica a moderadores (no se los puede esquivar).
const blockedPair = (a, b) => a !== b && a.nick && b.nick && !a.admin && !b.admin &&
  (a.blocked.has(b.nick.toLowerCase()) || b.blocked.has(a.nick.toLowerCase()));
const role = (c) => c.owner ? "owner" : c.admin ? "mod" : null;

// ---------- Baneos por celu + apodo (la IP sola no sirve: en los celus muchos comparten IP) ----------
// bans: "dev:<celu>" / "nick:<apodo>" / "ip:<ip>" -> { until, nick, by, reason, at }
const BAN_IP_MAX = 2 * 3600e3;  // por IP solo 2 h, para no dejar afuera a otros de la misma compañía de celular
const FOREVER = 8.64e15;
function banFind(ip, dev, nick) {
  const t = now();
  for (const k of [ip && "ip:" + ip, dev && "dev:" + dev, nick && "nick:" + String(nick).toLowerCase()]) {
    if (!k) continue;
    const b = bans.get(k);
    if (b && b.until > t) return b;
    if (b) bans.delete(k);
  }
  return null;
}
function banAdd(c, ms, reason, by) {
  const at = now(), until = ms === Infinity ? FOREVER : at + ms;
  const info = { until, nick: c.nick || "", by, reason, at };
  if (c.dev) bans.set("dev:" + c.dev, info);
  if (c.nick) bans.set("nick:" + c.nick.toLowerCase(), info);
  if (c.ip) bans.set("ip:" + c.ip, { ...info, until: Math.min(until, at + BAN_IP_MAX) });
  dirty();
}
function banRemove(nick) {
  const n = String(nick || "").toLowerCase().replace(/^@/, "");
  let k = 0; for (const [key, b] of bans) if ((b.nick || "").toLowerCase() === n) { bans.delete(key); k++; }
  if (k) dirty(); return k;
}
const fmtDur = (ms) => ms === Infinity || ms >= FOREVER / 2 ? "para siempre" : ms >= 86400e3 ? `${Math.round(ms / 86400e3)} día${Math.round(ms / 86400e3) === 1 ? "" : "s"}` : ms >= 3600e3 ? `${Math.round(ms / 3600e3)} h` : `${Math.max(1, Math.round(ms / 60000))} min`;
function parseDur(w) {
  w = String(w || "").toLowerCase();
  if (/^(perma|permanente|siempre|infinito)$/.test(w)) return Infinity;
  const m = w.match(/^(\d+)(m|min|h|hs|d|dias?|días?|sem|semanas?)$/); if (!m) return null;
  const n = Math.max(1, parseInt(m[1])), u = m[2][0];
  return n * (u === "m" ? 60000 : u === "h" ? 3600e3 : u === "s" ? 7 * 86400e3 : 86400e3);
}

// ---------- 📋 Registro de moderación (lo ve el dueño) ----------
let modLog = [];   // { at, by, text }
function logMod(by, text) {
  modLog.push({ at: now(), by: String(by || "?").slice(0, 30), text: String(text || "").slice(0, 200) });
  if (modLog.length > 200) modLog = modLog.slice(-200);
  dirty();
}

// ---------- 🛡️ Modo refugio (contra invasiones de bots o grupos) ----------
// Mientras está activo, los recién llegados pueden leer pero no escribir.
let refugioUntil = 0, refugioTimer = null;
const newJoins = [];
function setRefugio(min, by) {
  clearTimeout(refugioTimer);
  if (!min) { refugioUntil = 0; botSay("🛡️ Se terminó el modo refugio. Todos pueden escribir de nuevo."); return; }
  refugioUntil = now() + min * 60000;
  botSay(`🛡️ Modo refugio activado por ${min} min${by === BOT ? " (entró mucha gente nueva de golpe)" : ""}. Los recién llegados pueden leer, pero todavía no escribir. 💛`);
  refugioTimer = setTimeout(() => { if (refugioUntil && refugioUntil <= now() + 1000) setRefugio(0); }, min * 60000);
  refugioTimer.unref?.();
}
const userList = (viewer) =>
  [...clients.values()].filter((c) => c.nick && !(viewer && blockedPair(viewer, c)))
    .map((c) => ({ nick: c.nick, status: c.status, admin: c.admin, role: role(c), champ: isChamp(c.nick), av: c.avatar ? c.avVer : 0, bio: c.bio || "", ...achInfo(c), ...(canPhoto(c) ? { ph: true } : {}), ...(c.away ? { away: true } : {}) }))
    .sort((a, b) => a.nick.localeCompare(b.nick));
const pushUsers = () => { for (const [sid, c] of clients) if (c.nick) io.to(sid).emit("users", userList(c)); };
const emitToMods = (event, payload) => { for (const [sid, rc] of clients) if (rc.admin) io.to(sid).emit(event, payload); };
// Emite a todos menos a quienes tienen bloqueo con el remitente
function emitFrom(sender, event, payload, skipSelf = false) {
  for (const [sid, rc] of clients) {
    if (!rc.nick || (skipSelf && rc === sender) || blockedPair(rc, sender)) continue;
    io.to(sid).emit(event, payload);
  }
}

// huella de una foto/GIF/audio, para que al reenviar no se pueda cambiar el contenido
const mediaHash = (media) => { const d = media?.image || media?.gif || media?.audio; return d ? require("crypto").createHash("sha1").update(d).digest("base64") : ""; };
function remember(id, data) {
  messages.set(id, { ...data, text: String(data.text || "").slice(0, 160), fullText: String(data.text || "").slice(0, MAX_MSG), reactions: {} });
  if (messages.size > 3000) messages.delete(messages.keys().next().value);
}

// ---------- Sesiones: minimizar Chrome no te saca del chat ----------
// Cuando el celu pausa la página se corta la conexión, pero la persona sigue figurando
// (con 💤) durante GRACE_MS. Si vuelve en ese tiempo, recupera todo y recibe lo que se perdió.
// GRACE_MIN en Render: minutos que te guarda el lugar (máximo 1 día). "infinito" también vale 1 día.
const GRACE_MS = Math.min(1440, /^inf/i.test(process.env.GRACE_MIN || "") ? 1440 : (parseFloat(process.env.GRACE_MIN) || 15)) * 60000;
const sessions = new Map(); // token -> { c, id, timer, buf, bytes }
const ghostIds = new Map(); // id de la conexión cortada -> sesión
const newToken = () => require("crypto").randomBytes(18).toString("base64url");
const REPLAY = new Set(["public-message", "private-message", "edited", "deleted", "reactions", "poll-update", "poll-end", "notice", "announce", "clear",
  "pinned", "room-lock", "renamed", "secret-card", "rotos-q", "rotos-count", "user-joined", "user-left", "events", "juegos-ban"]);
// Guarda lo que le iba a llegar a cada persona en segundo plano (engancha todos los envíos del servidor)
const adapter = io.of("/").adapter;
const origBroadcast = adapter.broadcast.bind(adapter);
adapter.broadcast = function (packet, opts) {
  if (ghostIds.size && Array.isArray(packet?.data) && REPLAY.has(packet.data[0])) {
    for (const [gid, ses] of ghostIds) {
      if (opts?.except?.has?.(gid)) continue;
      if (opts?.rooms?.size && !opts.rooms.has(gid)) continue;
      const size = JSON.stringify(packet.data).length;
      ses.buf.push(packet.data); ses.bytes += size;
      while (ses.buf.length > 400 || ses.bytes > 4e6) ses.bytes -= JSON.stringify(ses.buf.shift()).length;
    }
  }
  return origBroadcast(packet, opts);
};
// Cerró la pestaña: el navegador avisa con /bye. Esperamos 5 s por si fue una recarga (en ese caso vuelve solo).
app.post("/bye", express.text({ type: "*/*", limit: "1kb" }), (req, res) => {
  res.status(204).end();
  const token = String(req.body || "").trim();
  const ses = sessions.get(token);
  if (!ses) return;
  const c = ses.c;
  clearTimeout(ses.byeTimer);
  ses.byeTimer = setTimeout(() => {
    if (sessions.get(token)?.c !== c) return; // volvió (era una recarga)
    const sock = io.sockets.sockets.get(ses.id);
    if (sock?.connected && !c.away) return; // sigue con la pestaña abierta
    c.gone = true;
    if (sock) sock.disconnect(true); else finalLeave(c, ses.id);
  }, 5000);
});
function goAway(c, sid) {
  const ses = sessions.get(c.token);
  if (!ses || c.gone) return finalLeave(c, sid);
  c.away = true; c.awayAt = now();
  ses.buf = []; ses.bytes = 0;
  ghostIds.set(sid, ses);
  clearTimeout(ses.timer);
  ses.timer = setTimeout(() => finalLeave(c, sid), GRACE_MS);
  pushUsers();
}
// Se va de verdad: lo que antes pasaba apenas se cortaba la conexión
function finalLeave(c, sid) {
  const ses = sessions.get(c.token);
  if (ses) { clearTimeout(ses.timer); if (ses.c === c) sessions.delete(c.token); }
  ghostIds.delete(sid);
  if (clients.get(sid) !== c) return; // ya volvió con otra conexión
  clients.delete(sid);
  if (!c.nick) return;
  for (const E of ENGINES) E.leave(c);
  if (users.get(c.nick.toLowerCase()) === sid) users.delete(c.nick.toLowerCase());
  emitFrom(c, "user-left", c.nick);
  pushUsers();
}

// ---------- Mensajes del bot ----------
function botSay(text, room = "general", name = BOT) {
  const id = newId();
  remember(id, { chat: room, from: name, text });
  io.emit("public-message", { id, room, from: name, bot: true, text, ts: now() });
}
const gameSay = (text) => botSay(text, "j-duelos", CRUPIER); // avisos generales de juegos (torneo semanal)
const notice = (socketId, text, kind = "bot") => io.to(socketId).emit("notice", { text, kind, ts: now() });
function notifyAdmins(text) {
  const id = newId();
  remember(id, { chat: "mods", from: BOT, text });
  emitToMods("public-message", { id, room: "mods", from: BOT, bot: true, text: "🛡️ " + text, ts: now() });
}

// ---------- Filtro ----------
function censor(text) {
  let hits = 0, harm = false;
  const n = norm(text);
  for (const h of HARM_WORDS) if (n.includes(h)) harm = true;
  const out = text.split(/(\s+)/).map((tok) => {
    if (/^\s+$/.test(tok)) return tok;
    const t = norm(tok).replace(/[^a-zñ]/g, "");
    if (t && BAD_WORDS.some((w) => !w.includes(" ") && t.startsWith(w))) { hits++; return tok[0] + "＊".repeat(Math.max(2, tok.length - 1)); }
    return tok;
  }).join("");
  let result = out;
  for (const w of BAD_WORDS.filter((w) => w.includes(" "))) {
    if (norm(result).includes(w)) { hits++; result = result.replace(new RegExp(w.split(" ").join("\\s+"), "gi"), "＊＊＊"); }
  }
  if (harm) {
    hits += 2;
    for (const h of HARM_WORDS) result = result.replace(new RegExp(h.split(" ").join("\\s+"), "gi"), "＊＊＊");
  }
  return { text: result, hits, harm };
}

// ---------- Sanciones ----------
// Penalizaciones de juegos: quedás afuera de 🎮 Juegos un rato (por apodo y por conexión)
// Se guarda por apodo y por dispositivo (no por IP: con datos móviles mucha gente comparte la misma IP)
const juegosBans = new Map(); // "nick:x" | "dev:x" -> vencimiento (ms)
const chatPenalties = new Map(); // igual, pero afuera de todo el chat (castigo "chat" de Verdad o reto)
const penKeys = (c, nick = c?.nick) => ["nick:" + String(nick || "").toLowerCase(), ...(c?.dev ? ["dev:" + c.dev] : [])];
function penUntil(map, c, nick) {
  const t = now(); let u = 0;
  for (const k of penKeys(c, nick)) { const v = map.get(k) || 0; if (v > t) u = Math.max(u, v); else map.delete(k); }
  return u;
}
const juegosBanUntil = (c) => penUntil(juegosBans, c);
const minsLeft = (u) => `${Math.ceil((u - now()) / 60000)} min`;
function juegosBanNotice(c, id) { const u = juegosBanUntil(c); if (!u) return false; notice(id, `⛔ Estás penalizado/a en 🎮 Juegos. Faltan ${minsLeft(u)}.`, "warn"); return true; }
function mute(c, id, minutes, reason, by = BOT) {
  c.mutedUntil = now() + minutes * 60000;
  voiceLeave(id);
  c.mutes++;
  notice(id, `🔇 Fuiste silenciado/a por ${minutes} min. Motivo: ${reason}`, "warn");
  logMod(by === BOT ? "🤖 automático" : by, `🔇 silenció a ${c.nick} ${minutes} min — ${reason}`);
  botSay(`🔇 ${c.nick} fue silenciado/a ${minutes} min${by !== BOT ? " por un moderador" : ""}. Motivo: ${reason}`);
}
function kick(id, reason, ban = false, by = BOT, ms = 24 * 3600e3) {
  const c = clients.get(id);
  if (!c) return;
  c.gone = true; // no queda "en segundo plano": se va de verdad
  if (c.away) setTimeout(() => finalLeave(c, id), 400);
  if (ban) banAdd(c, ms, reason, by);
  io.to(id).emit("kicked", { reason, ban, mins: ban ? (ms === Infinity ? -1 : Math.round(ms / 60000)) : 0 });
  botSay(`${ban ? "⛔" : "👢"} ${c.nick || "Alguien"} fue ${ban ? `baneado/a ${ms === Infinity ? "para siempre" : "por " + fmtDur(ms)}` : "expulsado/a"}${by !== BOT ? " por un moderador" : ""}. Motivo: ${reason}`);
  logMod(by === BOT ? "🤖 automático" : by, `${ban ? `⛔ baneó (${fmtDur(ms)})` : "👢 expulsó"} a ${c.nick || "?"} — ${reason}`);
  setTimeout(() => io.sockets.sockets.get(id)?.disconnect(true), 300);
}
function strike(c, id, n, reason) {
  const t = now();
  c.strikes = c.strikes.filter((s) => t - s < 10 * 60000);
  for (let i = 0; i < n; i++) c.strikes.push(t);
  if (c.strikes.length >= 3) {
    c.strikes = [];
    if (c.mutes >= 2) return kick(id, "Acumuló demasiadas sanciones");
    return mute(c, id, 5, reason);
  }
  notice(id, `⚠️ Advertencia ${c.strikes.length}/3: ${reason}. A la tercera te silencio 5 minutos.`, "warn");
}

// ---------- Validación de cada mensaje ----------
function checkMessage(c, id, raw, room = "general", allowEmpty = false, maxLen = MAX_MSG) {
  let text = String(raw || "").trim().slice(0, maxLen);
  if (!text && !allowEmpty) return null;
  const t = now();
  if (lockedRooms.has(room) && !c.admin) {
    notice(id, "🔒 Esta sala está cerrada por moderación. Solo pueden escribir los moderadores.", "warn");
    return null;
  }
  if (isGameRoom(room) && juegosBanNotice(c, id)) return null;
  if (c.mutedUntil > t) {
    notice(id, `🔇 Estás silenciado/a. Faltan ${Math.ceil((c.mutedUntil - t) / 60000)} min.`, "warn");
    return null;
  }
  if (refugioUntil > t && !c.admin && !c.veteran && !profiles.get(c.pkey)?.trusted) {
    notice(id, `🛡️ El chat está en modo refugio por un rato (faltan ${Math.ceil((refugioUntil - t) / 60000)} min): los recién llegados pueden leer pero todavía no escribir. ¡Gracias por la paciencia! 💛`, "warn");
    return null;
  }
  if (!c.admin) {
    if (slowMode && t - c.lastMsgAt < slowMode * 1000) {
      notice(id, `🐢 Modo lento activo: esperá ${Math.ceil((slowMode * 1000 - (t - c.lastMsgAt)) / 1000)} s.`, "warn");
      return null;
    }
    c.msgTimes = c.msgTimes.filter((x) => t - x < 8000);
    if (c.msgTimes.length >= (isGameRoom(room) ? 12 : 6)) { strike(c, id, 1, "Mandar mensajes muy rápido (flood)"); return null; }
    c.msgTimes.push(t);

    const key = norm(text) || "[media]" + t;
    c.repeat = key === c.lastText && !isGameRoom(room) ? c.repeat + 1 : 0;
    c.lastText = key;
    if (c.repeat >= 2) { strike(c, id, 1, "Repetir el mismo mensaje"); return null; }

    if (/https?:\/\/|www\./i.test(text) && t - c.joinedAt < 60000) {
      notice(id, "🔗 Podés mandar links después de tu primer minuto en el chat.", "warn");
      return null;
    }
    const letters = text.replace(/[^a-zA-ZÁÉÍÓÚÑáéíóúñ]/g, "");
    if (letters.length >= 12 && letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, "").length / letters.length > 0.7) text = text.toLowerCase();
  }
  c.lastMsgAt = t;
  if (!text) return "";
  const r = censor(text);
  if (r.hits && !c.admin) strike(c, id, r.harm ? 2 : 1, r.harm ? "Incitar a hacerse daño" : "Palabra bloqueada por moderación");
  // Señales de crisis: ayuda privada (máx. una vez cada 10 min) + aviso a moderadores
  if (CRISIS_RE.test(norm(text)) && t - c.lastCrisis > 10 * 60000) {
    c.lastCrisis = t;
    notice(id, HELP_TEXT, "help");
    notifyAdmins(`${c.nick} puede estar pasando un momento difícil. Quizás quieras escribirle.`);
  }
  return r.text;
}

// ---------- Comandos (/algo) ----------
function runCommand(c, id, text, room = "general") {
  // Tolerante al autocorrector del celu: "/ Crear clave Pedro", "/crear-clave", tildes, mayúsculas
  let body = text.slice(1).trim().replace(/\s+/g, " ");
  body = body.replace(/^(crear|quitar|anular|borrar)[\s_-]+clave\b/i, (m, v) => (v.toLowerCase() === "crear" ? "crearclave" : "quitarclave"))
             .replace(/^des[\s_-]+(mod|silenciar)\b/i, "des$1")
             .replace(/^desbanear[\s_-]+todo\b/i, "desbanear-todo")
             .replace(/^(sin|con)[\s_-]+fotos\b/i, "$1fotos");
  const [cmdRaw, ...rest] = body.split(" ");
  const cmd = cmdRaw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const arg = rest.join(" ").trim();

  if (GAME_CMDS.includes(cmd)) {
    const GE = ENGINE_BY_ROOM[room];
    if (!GE) return notice(id, `🎮 Los juegos son en las salas de Juegos.${CMD_KIND[cmd] ? ` Este va en ${ROOM_LABEL[CMD_KIND[cmd]]}.` : ""}`);
    return GE.command(c, id, cmd, arg);
  }

  if (cmd === "logros" || cmd === "niveles") return notice(id, logrosTop(), "help");
  if (cmd === "piezas") { const p = profiles.get(c.pkey); return notice(id, `🧩 Tenés ${p?.pz || 0} piezas. Gastalas en ✏️ Mi perfil → 🛒 Tienda.`, "help"); }
  if (cmd === "sintitulo") {
    if (!c.admin) return notice(id, "No tenés permiso para usar ese comando.", "warn");
    const t = byNick(arg); const p = t?.c?.pkey && profiles.get(t.c.pkey);
    if (!p?.eq?.title) return notice(id, "Esa persona no está conectada o no tiene título.", "warn");
    p.eq.title = ""; profDirty.add(t.c.pkey); usersSoon();
    notice(t.id, "🏷️ Un moderador te sacó el título. Podés poner otro desde la 🛒 Tienda (sin volver a pagar).", "warn");
    return notifyAdmins(`${c.nick} le sacó el título a ${t.c.nick}.`);
  }
  if (["permisofotos", "permitirfotos", "darfotos", "confiable", "quitarpermiso", "desconfiable", "aprobacion"].includes(cmd)) {
    if (!c.admin) return notice(id, "No tenés permiso para usar ese comando.", "warn");
    if (cmd === "permisofotos" || cmd === "aprobacion") {
      const v = plain(arg);
      if (!v) return notice(id, `📷 Permiso de fotos: ${approvalMode === "no" ? "DESACTIVADO (cualquiera puede mandar fotos)" : "ACTIVADO (hace falta que un mod lo dé)"}. Pedidos esperando: ${photoRequests.size}.\nDar: /permitirfotos <apodo> · Quitar: /quitarpermiso <apodo>\nDueño: /permisofotos si · /permisofotos no`, "mod");
      if (!c.owner) return notice(id, "Solo el dueño puede activar o desactivar el permiso de fotos.", "warn");
      if (!["si", "no", "nuevos"].includes(v)) return notice(id, "Usá: /permisofotos si (hace falta permiso) · /permisofotos no (cualquiera puede)", "warn");
      approvalMode = v === "no" ? "no" : "nuevos"; dirty();
      for (const [sid, rc] of clients) if (rc.nick) sendPerm(rc, sid);
      return notifyAdmins(`📷 ${c.nick} ${approvalMode === "no" ? "desactivó el permiso de fotos: ahora cualquiera puede mandar" : "activó el permiso de fotos: hace falta que un mod lo dé"}.`);
    }
    if (!arg) return notice(id, `Usá: /${cmd} <apodo>`, "warn");
    if (!setTrust(arg, ["permitirfotos", "darfotos", "confiable"].includes(cmd), c.nick)) return notice(id, "No encontré a esa persona conectada.", "warn");
    return;
  }
  if (cmd === "ayuda") {
    let help = "Comandos: /ayuda · /reglas · /logros (los de más nivel) · /admin <clave> · /juegos (en las salas de Juegos)";
    if (c.owner) help += "\nDueño 👑: /mod <apodo> (hacer moderador a alguien conectado) · /desmod <apodo> · /crearclave <nombre> (sin que esté conectado) · /quitarclave <nombre> · /mods (ver moderadores y claves) · /db (estado de la base de datos)";
    if (c.admin) help += "\n🛡️ Moderación (o usá el botón 🛡️ Panel):" +
      "\n• Usuarios: /info <apodo> · /advertir <apodo> [motivo] · /silenciar <apodo> [min] · /desilenciar <apodo> · /expulsar <apodo> [motivo] · /banear <apodo> [30m|2h|3d|1sem|perma] [motivo] · /desbanear <apodo> · /baneados · /desbanear-todo" +
      "\n• Seguridad: /refugio [min] (los recién llegados solo leen) · /refugio off · /registro (solo dueño: quién hizo qué)" +
      "\n• Más: /apodo <apodo> <nuevo> (cambiar apodo) · /sinavatar <apodo> (quitar foto de perfil) · /sinfotos <apodo> · /confotos <apodo> · /purgar <apodo> (borra sus mensajes)" +
      "\n• Salas: /cerrar · /abrir (en la sala actual) · /lento <seg> · /limpiar · /fijar <texto> · /desfijar · /anuncio <texto>" +
      "\n• Listas: /silenciados · /reportes · /filtro +palabra | -palabra | lista" +
      "\n• Sala 🛡️ Moderación: chat privado solo para moderadores";
    return notice(id, help);
  }
  if (cmd === "admin") {
    if (c.adminTries >= 5 || tooMany("admin", c.ip, 8, 15 * 60000)) return notice(id, "Demasiados intentos. Esperá un rato para probar de nuevo.");
    c.adminTries++;
    if (!arg) return notice(id, "Escribí /admin seguido de tu clave.");
    if (!ADMIN_PASSWORD && !modKeys.size) return notice(id, "⚠️ El servidor no tiene ADMIN_PASSWORD cargada. Agregala en Render → Environment.", "warn");
    if (ADMIN_PASSWORD && arg === ADMIN_PASSWORD) {
      c.admin = true; c.owner = true;
      pushUsers(); io.to(id).emit("admin", { mod: true, owner: true });
      return notice(id, "👑 Entraste como dueño/a. Podés nombrar moderadores con /mod <apodo>. Escribí /ayuda para ver todo.", "mod");
    }
    if (arg && modKeys.has(arg)) {
      c.admin = true; c.modKey = arg;
      pushUsers(); io.to(id).emit("admin", { mod: true, owner: false });
      return notice(id, "🛡️ Sos moderador/a. Escribí /ayuda para ver los comandos.", "mod");
    }
    io.to(id).emit("admin-fail");
    return notice(id, "Clave incorrecta.", "warn");
  }
  const MOD_ONLY = ["desbanear", "baneados", "registro", "refugio", "sinavatar", "db", "mod", "desmod", "mods", "crearclave", "quitarclave", "info", "advertir", "warn", "silenciar", "mute", "desilenciar", "unmute", "expulsar", "kick", "banear", "ban", "desbanear-todo", "fijar", "desfijar", "anuncio", "lento", "limpiar", "filtro", "reportes", "apodo", "sinfotos", "confotos", "purgar", "cerrar", "abrir", "silenciados"];
  if (!c.admin) return notice(id, MOD_ONLY.includes(cmd)
    ? `"/${cmd}" es un comando de moderación. Si sos el dueño o moderador, primero escribí /admin <tu clave> (tiene que aparecerte 👑 o 🛡️ al lado del nombre).`
    : `No conozco el comando "/${cmdRaw}". Probá /ayuda.`);

  const [targetNick, ...why] = arg.split(" ");
  const reason = why.join(" ") || "Decisión de moderación";
  const target = byNick(targetNick);
  if (["desilenciar", "unmute", "desbanear", "desbanear-todo", "mod", "desmod", "crearclave", "quitarclave", "fijar", "desfijar", "anuncio", "lento", "limpiar", "apodo", "sinfotos", "confotos", "purgar", "cerrar", "abrir", "refugio", "sintitulo", "advertir", "warn", "sinavatar"].includes(cmd) || (cmd === "filtro" && arg && arg !== "lista"))
    logMod(c.nick, `/${cmd}${arg ? " " + arg.slice(0, 120) : ""}${room && room !== "general" ? ` (en ${ROOM_LABEL?.[room] || room})` : ""}`);

  // Gestión de moderadores (solo el dueño)
  if (cmd === "db") {
    if (!c.owner) return notice(id, "Solo el dueño puede ver el estado de la base de datos.");
    if (!db.on) return notice(id, "💾 Base de datos: ❌ desactivada. Faltan UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN en Render.", "mod");
    return redis(["PING"]).then(() => notice(id, `💾 Base de datos: ✅ conectada.\nÚltimo guardado: ${db.lastSave ? new Date(db.lastSave).toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "todavía nada"}${db.pending ? " (hay cambios por guardar)" : ""}\nGuardando: ${modKeys.size} claves de mods · ${bans.size} baneos · ${points.size} en el ranking`, "mod"))
      .catch((e) => notice(id, `💾 Base de datos: ❌ error: ${e.message}. Revisá la URL y el token en Render.`, "warn"));
  }
  if (["mod", "desmod", "mods", "crearclave", "quitarclave"].includes(cmd)) {
    if (!c.owner) return notice(id, "Solo el dueño puede nombrar o quitar moderadores.");
    if (cmd === "crearclave") {
      const name = arg.trim().slice(0, 20);
      if (!name) return notice(id, "Uso: /crearclave <nombre>");
      const prev = [...modKeys].find(([, n]) => n.toLowerCase() === name.toLowerCase());
      if (prev) return notice(id, `${prev[1]} ya tiene clave: ${prev[0]}\nSi querés una nueva, primero /quitarclave ${prev[1]}`, "mod");
      const key = genKey(); modKeys.set(key, name); dirty();
      return notice(id, `🔑 Clave creada para ${name}: ${key}\nPasásela por WhatsApp. Cuando entre al chat (con cualquier apodo) escribe: /admin ${key}` + (db.on ? "\n💾 Queda guardada en la base de datos." : `\nPara que no se pierda si Render se reinicia, agregá en MOD_KEYS: ${name}:${key}`), "mod");
    }
    if (cmd === "quitarclave") {
      const name = arg.trim().toLowerCase();
      if (!name) return notice(id, "Uso: /quitarclave <nombre>");
      const keys = [...modKeys].filter(([, n]) => n.toLowerCase() === name).map(([k]) => k);
      if (!keys.length) return notice(id, `No hay ninguna clave a nombre de "${arg.trim()}". Mirá la lista con /mods`, "mod");
      keys.forEach((k) => modKeys.delete(k)); dirty();
      let echados = 0;
      for (const [sid, x] of clients) if (x.modKey && keys.includes(x.modKey)) {
        x.admin = false; x.modKey = ""; echados++;
        io.to(sid).emit("admin", { mod: false, owner: false }); notice(sid, "Tu clave de moderador fue anulada. Ya no sos moderador/a.");
      }
      if (echados) pushUsers();
      return notice(id, `🗑️ Clave de ${arg.trim()} anulada${echados ? " (estaba conectado/a y ya perdió el rol)" : ""}.\nSi estaba en MOD_KEYS de Render, borrala de ahí también.`, "mod");
    }
    if (cmd === "mods") {
      const online = [...clients.values()].filter((x) => x.admin && !x.owner).map((x) => x.nick);
      const keys = [...modKeys].map(([k, n]) => `${n} (clave: ${k})`);
      return notice(id, `🛡️ Conectados ahora: ${online.join(", ") || "ninguno"}\n🔑 Claves activas: ${keys.join(" · ") || "ninguna"}`, "mod");
    }
    if (!target) return notice(id, "No encuentro a ese usuario. Tiene que estar conectado.");
    if (target.c.owner) return notice(id, "Ya sos el dueño 😄");
    if (cmd === "mod") {
      let key = [...modKeys].find(([, n]) => n.toLowerCase() === target.c.nick.toLowerCase())?.[0];
      if (!key) { key = genKey(); modKeys.set(key, target.c.nick); dirty(); }
      target.c.admin = true; target.c.modKey = key;
      pushUsers(); io.to(target.id).emit("admin", { mod: true, owner: false });
      notice(target.id, `🛡️ ${c.nick} te nombró moderador/a. Tu clave es: ${key}\nGuardala: si te desconectás, escribí /admin ${key} para recuperar el rol.`, "mod");
      botSay(`🛡️ ${target.c.nick} ahora es moderador/a.`);
      return notice(id, `Listo. Clave de ${target.c.nick}: ${key}` + (db.on ? "\n💾 Queda guardada en la base de datos." : `\nPara que sea permanente (aunque se reinicie el servidor), agregá en Render la variable MOD_KEYS con: ${target.c.nick}:${key}`), "mod");
    }
    // desmod
    for (const [k, n] of modKeys) if (n.toLowerCase() === target.c.nick.toLowerCase()) modKeys.delete(k);
    dirty();
    target.c.admin = false;
    pushUsers(); io.to(target.id).emit("admin", { mod: false, owner: false });
    notice(target.id, "Ya no sos moderador/a.");
    return notice(id, `${target.c.nick} ya no es moderador/a. (Si estaba en MOD_KEYS de Render, sacalo de ahí también.)`, "mod");
  }

  // Los moderadores no pueden sancionar a otros moderadores ni al dueño
  if (target && target.c.admin && !c.owner && ["silenciar", "mute", "expulsar", "kick", "banear", "ban"].includes(cmd))
    return notice(id, "No podés sancionar a otro moderador. Hablalo con el dueño.");
  if (target && target.c.owner && ["silenciar", "mute", "expulsar", "kick", "banear", "ban"].includes(cmd))
    return notice(id, "No se puede sancionar al dueño.");

  switch (cmd) {
    case "silenciar": case "mute": {
      if (!target) return notice(id, "No encuentro a ese usuario.");
      const min = Math.min(1440, Math.max(1, parseInt(why[0]) || 10));
      return mute(target.c, target.id, min, why.slice(1).join(" ") || "Decisión de moderación", c.nick);
    }
    case "desilenciar": case "unmute":
      if (!target) return notice(id, "No encuentro a ese usuario.");
      target.c.mutedUntil = 0; target.c.strikes = [];
      penKeys(target.c).forEach((k) => juegosBans.delete(k));
      io.to(target.id).emit("juegos-ban", { until: 0 });
      notice(target.id, "🔊 Ya podés volver a escribir (y jugar).");
      return notice(id, `${target.c.nick} ya puede escribir.`, "mod");
    case "expulsar": case "kick":
      if (!target) return notice(id, "No encuentro a ese usuario.");
      return kick(target.id, reason, false, c.nick);
    case "banear": case "ban": {
      if (!target) return notice(id, "No encuentro a ese usuario (tiene que estar conectado/a). Uso: /banear Apodo [30m | 2h | 3d | 1sem | perma] motivo");
      let ms = parseDur(why[0]), rsn = reason;
      if (ms !== null) rsn = why.slice(1).join(" ") || "Decisión de moderación"; else ms = 24 * 3600e3;
      if (!c.owner && (ms === Infinity || ms > 7 * 86400e3)) return notice(id, "Los moderadores pueden banear hasta 1 semana. Para más (o para siempre), hablalo con el dueño.", "warn");
      return kick(target.id, rsn, true, c.nick, ms);
    }
    case "desbanear": {
      if (!arg) return notice(id, "Uso: /desbanear Apodo. Mirá la lista con /baneados.");
      const n = banRemove(targetNick);
      return notice(id, n ? `✅ ${targetNick} ya puede volver a entrar.` : `No encuentro un baneo activo de «${targetNick}». Mirá /baneados.`, "mod");
    }
    case "baneados": {
      const t = now(), seen = new Map();
      for (const [k, b] of bans) if (b.until > t && !k.startsWith("ip:") && b.nick) seen.set(b.nick.toLowerCase(), b);
      if (!seen.size) return notice(id, "No hay nadie baneado ahora. 🌿", "mod");
      return notice(id, "⛔ Baneados:\n" + [...seen.values()].map((b) => `• ${b.nick} — ${b.until >= FOREVER / 2 ? "para siempre" : "faltan " + fmtDur(b.until - t)} · por ${b.by === BOT ? "el bot" : b.by} · ${b.reason}`).join("\n") + "\n\nPara levantar uno: /desbanear Apodo", "mod");
    }
    case "registro": {
      if (!c.owner) return notice(id, "El registro de moderación lo ve solo el dueño.", "warn");
      const n = Math.min(60, Math.max(5, parseInt(arg) || 25));
      const fmt = (t) => new Date(t).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return notice(id, modLog.length ? `📋 Últimas ${Math.min(n, modLog.length)} acciones de moderación:\n` + modLog.slice(-n).reverse().map((x) => `${fmt(x.at)} · ${x.by}: ${x.text}`).join("\n") : "📋 Todavía no hay acciones registradas.", "mod");
    }
    case "refugio": {
      const a = arg.toLowerCase();
      if (/^(off|no|apagar|fin|terminar|0)$/.test(a)) { if (!refugioUntil) return notice(id, "El modo refugio no está activo.", "mod"); return setRefugio(0, c.nick); }
      return setRefugio(Math.min(240, Math.max(5, parseInt(a) || 30)), c.nick);
    }
    case "desbanear-todo":
      bans.clear(); dirty(); return notice(id, "Se levantaron todos los baneos.", "mod");
    case "fijar":
      pinned = arg.slice(0, 300); io.emit("pinned", pinned); dirty(); return;
    case "desfijar":
      pinned = ""; io.emit("pinned", ""); dirty(); return;
    case "anuncio":
      if (!arg) return;
      return io.emit("announce", { text: arg.slice(0, 400), ts: now() });
    case "lento":
      slowMode = Math.min(120, Math.max(0, parseInt(arg) || 0)); dirty();
      return botSay(slowMode ? `🐢 Modo lento activado: un mensaje cada ${slowMode} s.` : "🐇 Modo lento desactivado.");
    case "limpiar":
      io.emit("clear", { room }); return botSay("🧹 Un moderador limpió la sala.", room);
    case "filtro": {
      if (arg === "lista" || !arg) return notice(id, "Filtro: " + BAD_WORDS.join(", "), "mod");
      const w = norm(arg.slice(1)).trim();
      if (!w) return;
      if (arg[0] === "+" && !BAD_WORDS.includes(w)) BAD_WORDS.push(w);
      if (arg[0] === "-") BAD_WORDS = BAD_WORDS.filter((x) => x !== w);
      dirty();
      return notice(id, `Filtro actualizado (${BAD_WORDS.length} palabras).`, "mod");
    }
    case "info": {
      if (!target) return notice(id, "No encuentro a ese usuario.");
      const u = target.c, t = now();
      const mins = Math.round((t - u.joinedAt) / 60000);
      const rep = reports.get(u.nick.toLowerCase())?.size || 0;
      return notice(id, `ℹ️ ${u.nick}${u.owner ? " 👑" : u.admin ? " 🛡️" : ""}\n• Conectado hace ${mins} min · estado: ${u.status}` +
        `\n• Advertencias recientes: ${u.strikes.filter((x) => t - x < 600000).length}/3 · silencios: ${u.mutes}` +
        `\n• ${u.mutedUntil > t ? `🔇 Silenciado/a (${Math.ceil((u.mutedUntil - t) / 60000)} min)` : "Puede escribir"} · ${u.noMedia ? "📷 sin fotos" : "fotos permitidas"}` +
        `\n• Reportes (15 min): ${rep}`, "mod");
    }
    case "advertir": case "warn": {
      if (!target) return notice(id, "No encuentro a ese usuario.");
      if (target.c.admin && !c.owner) return notice(id, "No podés advertir a otro moderador.");
      notifyAdmins(`${c.nick} advirtió a ${target.c.nick}: ${reason}`);
      return strike(target.c, target.id, 1, `${reason} (aviso de ${c.nick})`);
    }
    case "apodo": {
      if (!target) return notice(id, "No encuentro a ese usuario.");
      if (target.c.admin && !c.owner) return notice(id, "No podés cambiarle el apodo a otro moderador.");
      const nuevo = why.join(" ").trim().replace(/\s+/g, " ").slice(0, 20);
      if (nuevo.length < 2 || !/^[\p{L}\p{N} _.\-]+$/u.test(nuevo)) return notice(id, "Apodo nuevo inválido. Uso: /apodo <apodo> <nuevo>");
      if (users.has(nuevo.toLowerCase())) return notice(id, "Ese apodo ya está en uso.");
      const viejo = target.c.nick;
      users.delete(viejo.toLowerCase()); users.set(nuevo.toLowerCase(), target.id);
      target.c.nick = nuevo;
      io.to(target.id).emit("renamed", nuevo);
      notice(target.id, `✏️ Un moderador cambió tu apodo a "${nuevo}".`, "warn");
      pushUsers();
      return botSay(`✏️ ${viejo} ahora se llama ${nuevo}.`);
    }
    case "sinavatar": {
      if (!target) return notice(id, "No encuentro a ese usuario.");
      if (target.c.admin && !c.owner) return notice(id, "No podés hacer eso con otro moderador.");
      target.c.avatar = null; target.c.noAvatar = true; pushUsers();
      notice(target.id, "🖼️ Un moderador quitó tu foto de perfil.", "warn");
      return notice(id, `🖼️ Quitaste la foto de perfil de ${target.c.nick} (no puede poner otra hasta que se reconecte).`, "mod");
    }
    case "sinfotos": case "confotos": {
      if (!target) return notice(id, "No encuentro a ese usuario.");
      target.c.noMedia = cmd === "sinfotos";
      notice(target.id, target.c.noMedia ? "📷 Un moderador te sacó el permiso de mandar fotos y GIFs." : "📷 Ya podés volver a mandar fotos y GIFs.", target.c.noMedia ? "warn" : "help");
      return notice(id, `${target.c.nick}: fotos ${target.c.noMedia ? "bloqueadas" : "permitidas"}.`, "mod");
    }
    case "purgar": {
      const n = (target?.c.nick || targetNick || "").toLowerCase();
      if (!n) return notice(id, "Uso: /purgar <apodo>");
      let count = 0;
      for (const [mid, m] of messages) {
        if (m.chat === "general" || isGameRoom(m.chat)) if (m.from.toLowerCase() === n) { messages.delete(mid); io.emit("deleted", { id: mid, byMod: true }); count++; }
      }
      notifyAdmins(`${c.nick} borró ${count} mensaje(s) de ${targetNick}.`);
      return notice(id, `🧹 Borrados ${count} mensaje(s) de ${targetNick}.`, "mod");
    }
    case "cerrar": case "abrir": {
      if (room === "mods") return notice(id, "La sala de moderación no se puede cerrar.");
      cmd === "cerrar" ? lockedRooms.add(room) : lockedRooms.delete(room); dirty();
      io.emit("room-lock", { room, locked: cmd === "cerrar" });
      return botSay(cmd === "cerrar" ? "🔒 Sala cerrada por moderación. Por ahora solo escriben los moderadores." : "🔓 Sala abierta de nuevo. ¡Pueden escribir!", room);
    }
    case "silenciados": {
      const t = now();
      const list = [...clients.values()].filter((u) => u.nick && u.mutedUntil > t).map((u) => `${u.nick} (${Math.ceil((u.mutedUntil - t) / 60000)} min)`);
      return notice(id, list.length ? "🔇 Silenciados: " + list.join(" · ") : "No hay nadie silenciado.", "mod");
    }
    case "reportes": {
      const lines = [...reports].map(([n, m]) => `${n}: ${m.size} reporte(s)`);
      return notice(id, lines.length ? "Reportes: " + lines.join(" · ") : "No hay reportes.", "mod");
    }
    default:
      return notice(id, `No conozco el comando "/${cmdRaw}". Probá /ayuda para ver la lista.`);
  }
}

// ---------- Fotos y GIFs ----------
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const AUDIO_RE = /^data:audio\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav)(;codecs=[\w.,"-]+)?;base64,[A-Za-z0-9+/=]+$/i;
const GIF_RE = /^https:\/\/(media\d*|i)\.giphy\.com\/[\w\-./?=&%]+$/;
function checkMedia(c, id, p) {
  const media = {};
  if ((p.image || p.gif || p.audio) && c.noMedia && !c.admin) { notice(id, "📷 Un moderador te sacó el permiso de mandar fotos, GIFs y audios.", "warn"); return null; }
  if (p.image) {
    if (typeof p.image !== "string" || p.image.length > 3.6e6 || !IMG_RE.test(p.image)) { notice(id, "📷 La imagen no es válida o es muy pesada (máx. ~2,5 MB).", "warn"); return null; }
    media.image = p.image;
  } else if (p.audio) {
    if (typeof p.audio !== "string" || p.audio.length > 1.8e6 || !AUDIO_RE.test(p.audio)) { notice(id, "🎤 El audio no es válido o es muy largo (máx. 1 minuto).", "warn"); return null; }
    media.audio = p.audio;
  } else if (p.gif) {
    if (typeof p.gif !== "string" || p.gif.length > 500 || !GIF_RE.test(p.gif)) { notice(id, "GIF no válido.", "warn"); return null; }
    media.gif = p.gif;
  } else return {};
  const t = now();
  if (!c.admin) {
    if (t - c.joinedAt < 60000) { notice(id, "📷 Podés mandar fotos, GIFs y audios después de tu primer minuto en el chat.", "warn"); return null; }
    if (t - c.lastMediaAt < 8000) { notice(id, "📷 Esperá unos segundos antes de mandar otra foto, GIF o audio.", "warn"); return null; }
  }
  c.lastMediaAt = t;
  return media;
}
const mediaLabel = (m) => m.image ? "📷 Foto" : m.gif ? "🎞️ GIF" : m.audio ? "🎤 Audio" : "";

// Publica un mensaje en una sala (también se usa al aprobar una foto que estaba esperando)
function publishPublic(c, room, text, media, replyTo) {
  const id = newId();
  const reply = buildReply(replyTo, room);
  remember(id, { chat: room, from: c.nick, pkey: c.pkey, text: text || mediaLabel(media), cap: text || "", mh: mediaHash(media), ts: now(), media: !!(media.image || media.gif || media.audio) });
  const out = { id, room, from: c.nick, admin: c.admin, role: role(c), text, ...media, reply, ts: now() };
  if (room === "mods") emitToMods("public-message", out);
  else if (room === "confesiones") {
    // Nadie ve el nombre; los moderadores sí (para poder moderar); el autor lo ve como propio
    const anon = { id, room, from: "Anónimo", anon: true, text, ...media, reply, ts: out.ts };
    for (const [sid, rc] of clients) {
      if (!rc.nick || blockedPair(rc, c)) continue;
      io.to(sid).emit("public-message", rc.pkey && rc.pkey === c.pkey ? { ...anon, mine: true } : rc.admin ? { ...anon, realFrom: c.nick } : anon);
    }
  } else emitFrom(c, "public-message", out);
}

// ---------- Responder mensajes ----------
function buildReply(replyTo, room, me, other) {
  const m = messages.get(String(replyTo || ""));
  if (!m) return undefined;
  if (room) { if (m.chat !== room) return undefined; }
  else if (m.chat !== "private" || ![m.from, m.to].includes(me) || ![m.from, m.to].includes(other)) return undefined;
  return { id: replyTo, from: m.chat === "confesiones" ? "Anónimo" : m.from, text: m.text.slice(0, 120) };
}

// ================== Juegos ==================
const GAME_CMDS = ["quiendijo", "quienesia", "turing", "mentiroso", "impostor", "asesinato", "100rotos", "rotos", "juicio", "eliminatorio", "llaves", "vor", "verdadoreto", "dibujo", "torneo", "ia", "juegos", "trivia", "ahorcado", "ranking", "rendirse"];
// En qué sub-sala se juega cada cosa
const ROOM_LABEL = { trivia: "🧠 Trivia", ia: "🕵️ Engaño e IA", fiesta: "🎉 Fiesta", duelos: "⚔️ Duelos" };
const CMD_KIND = { trivia: "trivia", ahorcado: "trivia", quiendijo: "trivia",
  quienesia: "ia", turing: "ia", mentiroso: "ia", impostor: "ia", asesinato: "ia",
  vor: "fiesta", verdadoreto: "fiesta", dibujo: "fiesta", "100rotos": "fiesta", rotos: "fiesta", juicio: "fiesta",
  eliminatorio: "duelos", llaves: "duelos" };
const CUSTOM_OF = { trivia: ["trivia", "ahorcado"], ia: ["turing", "mentiroso", "impostor", "asesinato"], fiesta: ["vor", "dibujo", "rotos"], duelos: ["eliminatorio"] };
const GAME_HELP = {
  trivia: "❓ /trivia [tema] — una pregunta\n🏁 /trivia ronda 10 cine, música — varias seguidas\n🪢 /ahorcado\n🗣️ /quiendijo [rondas] — ¿Quién dijo esto? con frases célebres del chat",
  ia: "🤖 /quienesia — ¿Quién es la IA?\n🃏 /mentiroso — inventá mentiras creíbles\n🫣 /impostor [palabra / parecida]\n🔪 /asesinato [tema] — misterio",
  fiesta: "🎭 /vor — Verdad o reto (castigo: /vor ban 10 · /vor silencio 5 · /vor chat 5 · /vor puntos 3 · /vor sin)\n🖍️ /dibujo [rondas] — Dibujá y adiviná\n📊 /100rotos — pensá como la mayoría\n⚖️ /juicio Nombre cargo — Juicio popular en broma",
  duelos: "⚔️ Duelos 1 contra 1: tocá el nombre de alguien → Desafiar\n🏟️ /eliminatorio — torneo con llaves (/llaves para verlas)\n🏆 /torneo — torneo de la semana",
};
const points = new Map(); // apodo -> puntos
const addPoints = (nick, n) => { points.set(nick, (points.get(nick) || 0) + n); weekly.points.set(nick, (weekly.points.get(nick) || 0) + n); dirty(); };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const plain = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]/g, "").replace(/\s+/g, " ").trim();

const TRIVIA = [
  ["¿Cuál es la capital de Australia?", ["canberra"]],
  ["¿Cuántos jugadores tiene un equipo de fútbol en la cancha?", ["11", "once"]],
  ["¿Qué planeta es conocido como el planeta rojo?", ["marte"]],
  ["¿Quién pintó la Mona Lisa?", ["leonardo", "da vinci", "leonardo da vinci"]],
  ["¿Cuántos lados tiene un hexágono?", ["6", "seis"]],
  ["¿Cuál es el océano más grande del mundo?", ["pacifico", "oceano pacifico"]],
  ["¿Cuál es el símbolo químico del oro?", ["au"]],
  ["¿Cuál es la capital de Canadá?", ["ottawa"]],
  ["¿Quién escribió \"Don Quijote de la Mancha\"?", ["cervantes", "miguel de cervantes"]],
  ["¿En qué país nació el tango?", ["argentina"]],
  ["¿En qué país se jugó el Mundial 2022?", ["qatar", "catar"]],
  ["¿Cuántos huesos tiene el cuerpo humano adulto?", ["206"]],
  ["¿Cuál es el animal terrestre más rápido?", ["guepardo", "chita", "cheetah"]],
  ["¿Cuál es la capital de Japón?", ["tokio", "tokyo"]],
  ["¿Quién escribió \"Rayuela\"?", ["cortazar", "julio cortazar"]],
  ["¿Quién escribió \"El Aleph\"?", ["borges", "jorge luis borges"]],
  ["¿Cuál es la montaña más alta de América?", ["aconcagua"]],
  ["¿Cuántos minutos tiene un día?", ["1440"]],
  ["¿Qué instrumento tocaba Astor Piazzolla?", ["bandoneon", "el bandoneon"]],
  ["¿En qué provincia argentina están las Cataratas del Iguazú?", ["misiones"]],
  ["¿Cuántas cuerdas tiene una guitarra criolla estándar?", ["6", "seis"]],
  ["¿Cuál es el planeta más grande del sistema solar?", ["jupiter"]],
  ["¿Quién formuló la teoría de la relatividad?", ["einstein", "albert einstein"]],
  ["¿Qué idioma se habla en Brasil?", ["portugues"]],
  ["¿Cuántos días tiene un año bisiesto?", ["366"]],
  ["¿Qué banda cantaba \"De música ligera\"?", ["soda stereo", "soda"]],
  ["¿Cuánto vale la L en números romanos?", ["50", "cincuenta"]],
  ["¿Cuál es la raíz cuadrada de 144?", ["12", "doce"]],
  ["¿Qué órgano bombea la sangre?", ["corazon", "el corazon"]],
  ["¿Cuál es la capital de Chile?", ["santiago", "santiago de chile"]],
  ["¿Cuál es el animal terrestre más alto?", ["jirafa", "la jirafa"]],
  ["¿Cuántas patas tiene una araña?", ["8", "ocho"]],
  ["¿Cuál es el país más grande del mundo?", ["rusia"]],
  ["¿Quién propuso la ley de la gravitación universal?", ["newton", "isaac newton"]],
  ["¿Cuál es el hueso más largo del cuerpo humano?", ["femur", "el femur"]],
  ["¿Cuál es la capital de Uruguay?", ["montevideo"]],
  ["¿Quién fue el DT de Argentina campeona en México 86?", ["bilardo", "carlos bilardo"]],
  ["¿Cuántos jugadores tiene un equipo de básquet en la cancha?", ["5", "cinco"]],
  ["¿En qué ciudad está la Torre Eiffel?", ["paris"]],
  ["¿Cuál es la fórmula química del agua?", ["h2o"]],
  ["¿Qué personaje famoso creó Quino?", ["mafalda"]],
  ["¿Cuál es el desierto cálido más grande del mundo?", ["sahara", "el sahara"]],
  ["¿Cuántos colores tiene el arcoíris?", ["7", "siete"]],
  ["¿Cuál es la capital de Perú?", ["lima"]],
  ["¿Cuántos segundos tiene una hora?", ["3600"]],
  ["¿De qué país es originario el tango?", ["argentina", "argentina y uruguay", "uruguay"]],
  ["¿Qué gas necesitan las plantas para hacer la fotosíntesis?", ["dioxido de carbono", "co2"]],
  ["¿Cuál es la capital de Egipto?", ["el cairo", "cairo"]],
  ["¿Cuántas provincias tiene Argentina (sin contar CABA)?", ["23", "veintitres"]],
  ["¿Qué animal es el mamífero más grande del mundo?", ["ballena azul", "la ballena azul", "ballena"]],
  ["¿Cómo se llama la cría de la rana?", ["renacuajo", "el renacuajo"]],
  ["¿Qué insecto produce la miel?", ["abeja", "la abeja", "abejas"]],
  ["¿Cuál es el ave que no vuela y vive en la Antártida?", ["pinguino", "el pinguino"]],
  ["¿Qué animal es el 'rey de la selva'?", ["leon", "el leon"]],
  ["¿Cómo se llama el grupo de leones?", ["manada", "la manada"]],
  ["¿Qué animal puede cambiar de color para camuflarse?", ["camaleon", "el camaleon"]],
  ["¿Cuál es el único mamífero que puede volar?", ["murcielago", "el murcielago"]],
  ["¿Qué animal tiene la memoria más famosa por ser buena?", ["elefante", "el elefante"]],
  ["¿Cómo se llama la casa de las abejas?", ["colmena", "la colmena"]],
  ["¿Qué animal marino tiene ocho brazos?", ["pulpo", "el pulpo"]],
  ["¿Cuál es el animal más venenoso: medusa, araña o abeja... la más letal del mar?", ["medusa", "avispa de mar", "medusa avispa"]],
  ["¿Qué animal duerme parado?", ["caballo", "el caballo"]],
  ["¿Cómo se llama el bebé de la vaca?", ["ternero", "el ternero", "ternera"]],
  ["¿Qué reptil es famoso por su caparazón?", ["tortuga", "la tortuga"]],
  ["¿Qué animal australiano guarda a su cría en una bolsa?", ["canguro", "el canguro"]],
  ["¿Cuál es el pez más grande del mundo?", ["tiburon ballena", "el tiburon ballena"]],
  ["¿Qué animal hace 'muuu'?", ["vaca", "la vaca"]],
  ["¿Cómo se llaman las rayas del cebra en una palabra: es blanco con negro o negro con blanco? Decí el color de fondo real", ["negro"]],
  ["¿Qué animal es el mejor amigo del hombre?", ["perro", "el perro"]],
  ["¿Cuál es el río más largo del mundo?", ["nilo", "el nilo", "amazonas", "el amazonas"]],
  ["¿En qué continente está Egipto?", ["africa"]],
  ["¿Cuál es el país con forma de bota?", ["italia"]],
  ["¿Cuál es la capital de Francia?", ["paris"]],
  ["¿Cuál es la capital de España?", ["madrid"]],
  ["¿Cuál es la capital de Italia?", ["roma"]],
  ["¿Cuál es la capital de Alemania?", ["berlin"]],
  ["¿Cuál es la capital de Inglaterra?", ["londres"]],
  ["¿Cuál es la capital de Brasil?", ["brasilia"]],
  ["¿Cuál es la capital de México?", ["ciudad de mexico", "mexico df", "cdmx", "mexico"]],
  ["¿Cuál es la capital de Estados Unidos?", ["washington", "washington dc"]],
  ["¿En qué país está la Casa Rosada?", ["argentina"]],
  ["¿Cuál es el país más austral del mundo (sin contar la Antártida)?", ["argentina", "chile"]],
  ["¿Cómo se llama la cordillera que separa Argentina de Chile?", ["los andes", "andes", "la cordillera de los andes"]],
  ["¿Cuál es el océano que baña las costas argentinas?", ["atlantico", "el atlantico", "oceano atlantico"]],
  ["¿En qué provincia está la ciudad de Bariloche?", ["rio negro"]],
  ["¿Cuál es la provincia más grande de Argentina?", ["buenos aires"]],
  ["¿En qué país está la Torre de Pisa?", ["italia"]],
  ["¿En qué país está la Estatua de la Libertad?", ["estados unidos", "eeuu", "usa"]],
  ["¿Cuál es el continente más grande?", ["asia"]],
  ["¿Cuál es el continente más frío?", ["antartida", "la antartida"]],
  ["¿Cuál es el desierto más grande de Argentina?", ["la patagonia", "patagonia", "desierto patagonico"]],
  ["¿En qué país están las pirámides de Guiza?", ["egipto"]],
  ["¿Cuál es la capital de China?", ["pekin", "beijing"]],
  ["¿Cuál es la capital de Rusia?", ["moscu"]],
  ["¿Qué mar separa Europa de África?", ["mediterraneo", "el mediterraneo", "mar mediterraneo"]],
  ["¿Cuál es la catarata más alta del mundo?", ["salto angel", "el salto angel"]],
  ["¿Qué planeta habitamos?", ["tierra", "la tierra"]],
  ["¿Cuál es la estrella más cercana a la Tierra?", ["el sol", "sol"]],
  ["¿Qué satélite natural tiene la Tierra?", ["la luna", "luna"]],
  ["¿Qué gas respiramos para vivir?", ["oxigeno", "el oxigeno"]],
  ["¿Cuál es el planeta más cercano al Sol?", ["mercurio"]],
  ["¿Cuál es el planeta de los anillos?", ["saturno"]],
  ["¿De qué color es la sangre cuando tiene oxígeno?", ["roja", "rojo"]],
  ["¿Qué órgano usamos para pensar?", ["cerebro", "el cerebro"]],
  ["¿Cuántos pulmones tiene el ser humano?", ["2", "dos"]],
  ["¿Qué parte del cuerpo bombea la sangre?", ["corazon", "el corazon"]],
  ["¿Qué vitamina nos da el sol?", ["vitamina d", "d", "la d"]],
  ["¿Cuál es el metal líquido a temperatura ambiente?", ["mercurio", "el mercurio"]],
  ["¿Qué fuerza nos mantiene pegados al piso?", ["gravedad", "la gravedad"]],
  ["¿En qué estado está el agua cuando se congela?", ["solido", "hielo", "estado solido"]],
  ["¿Qué se forma cuando el agua hierve y se evapora?", ["vapor", "vapor de agua"]],
  ["¿Cuál es el sentido que usamos para oler?", ["olfato", "el olfato"]],
  ["¿Cuántos dientes tiene un adulto sano?", ["32", "treinta y dos"]],
  ["¿Qué planeta es el más grande del sistema solar?", ["jupiter"]],
  ["¿Qué instrumento usa un médico para escuchar el corazón?", ["estetoscopio", "el estetoscopio"]],
  ["¿Qué animal fue el primero en ir al espacio?", ["perro", "perra", "la perra laika", "laika"]],
  ["¿Con qué parte del cuerpo NO se puede tocar la pelota en el fútbol (si no sos arquero)?", ["mano", "las manos", "la mano", "manos"]],
  ["¿Cuántos tiempos tiene un partido de fútbol?", ["2", "dos"]],
  ["¿En qué deporte se usa una raqueta y una red en el medio?", ["tenis", "el tenis"]],
  ["¿Qué país ganó el Mundial de fútbol de Qatar?", ["argentina"]],
  ["¿En qué deporte se hace un 'home run'?", ["beisbol", "el beisbol"]],
  ["¿Cuántos anillos tiene el símbolo olímpico?", ["5", "cinco"]],
  ["¿En qué deporte destacó Michael Jordan?", ["basquet", "basketball", "basket", "baloncesto"]],
  ["¿Qué selección tiene a la 'Canarinha' de apodo?", ["brasil"]],
  ["¿En qué deporte se usa un palo y un hoyo?", ["golf", "el golf"]],
  ["¿Qué número de camiseta usaba Maradona?", ["10", "diez"]],
  ["¿En qué deporte juega la NBA?", ["basquet", "basketball", "basket", "baloncesto"]],
  ["¿Cuántos jugadores hay en un equipo de vóley en cancha?", ["6", "seis"]],
  ["¿En qué ciudad argentina está el estadio 'La Bombonera'?", ["buenos aires", "caba", "capital"]],
  ["¿De qué club es la cancha 'El Monumental'?", ["river", "river plate"]],
  ["¿Qué tenista argentino ganó medalla de oro olímpica en Atenas?", ["nalbandian", "del potro", "gaudio"]],
  ["¿Qué banda inglesa integraban John, Paul, George y Ringo?", ["los beatles", "the beatles", "beatles"]],
  ["¿Quién cantaba 'Thriller' y es el 'rey del pop'?", ["michael jackson", "jackson"]],
  ["¿Qué instrumento tiene teclas blancas y negras?", ["piano", "el piano"]],
  ["¿Cómo se llama el personaje de orejas grandes creado por Disney, un ratón?", ["mickey", "mickey mouse"]],
  ["¿Qué superhéroe es 'el hombre araña'?", ["spiderman", "spider man", "hombre araña"]],
  ["¿De qué color es Hulk?", ["verde"]],
  ["¿Qué juguete vaquero dice 'hay una serpiente en mi bota' en Toy Story?", ["woody"]],
  ["¿Qué princesa perdió un zapato de cristal?", ["cenicienta", "la cenicienta"]],
  ["¿Quién dibujó a Mafalda?", ["quino"]],
  ["¿Qué cantante argentino es conocido como 'el Flaco'?", ["spinetta", "luis alberto spinetta"]],
  ["¿Qué banda argentina cantaba 'Matador'?", ["los fabulosos cadillacs", "cadillacs", "los cadillacs"]],
  ["¿Qué instrumento es típico del tango?", ["bandoneon", "el bandoneon"]],
  ["¿Cómo se llama el robot amarillo de La Guerra de las Galaxias?", ["c3po", "c-3po"]],
  ["¿Qué color se obtiene al mezclar azul y amarillo?", ["verde"]],
  ["¿Qué color se obtiene al mezclar rojo y amarillo?", ["naranja"]],
  ["¿Qué color se obtiene al mezclar rojo y azul?", ["violeta", "morado", "purpura"]],
  ["¿De qué fruta se hace el vino?", ["uva", "la uva", "uvas"]],
  ["¿Qué ingrediente principal tiene el guacamole?", ["palta", "aguacate", "la palta"]],
  ["¿De qué animal sale la leche que más tomamos?", ["vaca", "la vaca"]],
  ["¿Qué comida italiana es redonda y lleva salsa y queso?", ["pizza", "la pizza"]],
  ["¿Qué bebida caliente argentina se toma con bombilla?", ["mate", "el mate"]],
  ["¿De qué se hace principalmente el pan?", ["harina", "la harina"]],
  ["¿Qué fruta es amarilla y curva y les gusta a los monos?", ["banana", "la banana", "platano"]],
  ["¿Qué dulce argentino se hace con leche y azúcar, untable?", ["dulce de leche"]],
  ["¿Qué verdura te hace llorar al cortarla?", ["cebolla", "la cebolla"]],
  ["¿Qué comida típica argentina se hace a la parrilla con amigos?", ["asado", "el asado"]],
  ["¿Cuál es el ingrediente principal del hummus?", ["garbanzo", "garbanzos", "los garbanzos"]],
  ["¿Qué fruta cítrica es famosa por la vitamina C?", ["naranja", "la naranja", "limon"]],
  ["¿Qué pasta tiene forma de tubo?", ["tirabuzon", "macarron", "penne", "mostachol", "mostacholes"]],
  ["¿Cuántas letras tiene el abecedario español (con la ñ)?", ["27", "veintisiete"]],
  ["¿Qué signo se pone al inicio de una pregunta en español?", ["signo de interrogacion", "interrogacion", "¿"]],
  ["¿Cómo se dice 'gato' en inglés?", ["cat"]],
  ["¿Cómo se dice 'perro' en inglés?", ["dog"]],
  ["¿Cómo se dice 'gracias' en portugués?", ["obrigado", "obrigada"]],
  ["¿Qué forma geométrica tiene tres lados?", ["triangulo", "el triangulo"]],
  ["¿Cuántos lados tiene un cuadrado?", ["4", "cuatro"]],
  ["¿Cuántos lados tiene un pentágono?", ["5", "cinco"]],
  ["¿Qué número viene después del 99?", ["100", "cien"]],
  ["¿Cuánto es 7 por 8?", ["56", "cincuenta y seis"]],
  ["¿Cuánto es la mitad de 50?", ["25", "veinticinco"]],
  ["¿Qué instrumento marca los puntos cardinales?", ["brujula", "la brujula"]],
  ["¿Qué color está arriba en el semáforo?", ["rojo"]],
  ["¿Cuántos días tiene una semana?", ["7", "siete"]],
  ["¿Cuántos meses tiene el año?", ["12", "doce"]],
  ["¿Cuál es el primer mes del año?", ["enero"]],
  ["¿Cuál es el último mes del año?", ["diciembre"]],
  ["¿En qué dirección sale el sol?", ["este", "el este", "oriente"]],
  ["¿Qué planeta tiene vida conocida?", ["tierra", "la tierra"]],
  ["¿Cómo se llama el papá de tu papá para vos?", ["abuelo", "el abuelo"]],
  ["¿Qué metal precioso tiene el símbolo 'Ag'?", ["plata", "la plata"]],
  ["¿Qué se mide en grados Celsius?", ["temperatura", "la temperatura"]],
  ["¿Qué instrumento usamos para ver la hora?", ["reloj", "el reloj"]],
  ["¿Cuántos lados tiene un rombo?", ["4", "cuatro"]],
  ["¿Qué moneda se usa en Argentina?", ["peso", "el peso", "pesos"]],
  ["¿Qué moneda se usa en Estados Unidos?", ["dolar", "el dolar", "dolares"]],
  ["¿Qué moneda se usa en la mayoría de Europa?", ["euro", "el euro"]],
  ["¿Cómo se llama la línea imaginaria que divide la Tierra en norte y sur?", ["ecuador", "la linea del ecuador", "el ecuador"]],
  ["¿Qué aparato inventó Thomas Edison y da luz?", ["lampara", "la lamparita", "bombilla", "foco", "lamparita"]],
  ["¿Qué animal mitológico tiene cuerpo de caballo y un cuerno?", ["unicornio", "el unicornio"]],
  ["¿Qué criatura mitológica tira fuego por la boca?", ["dragon", "el dragon"]],
  ["¿Cómo se llama el hombre de las nieves del Himalaya?", ["yeti", "el yeti"]],
  ["¿Qué planeta está entre la Tierra y el Sol?", ["venus", "mercurio"]],
  ["¿Qué forma tiene una pelota?", ["esfera", "redonda", "circulo"]],
  ["¿Qué estación viene después del invierno?", ["primavera", "la primavera"]],
  ["¿Cuántas horas tiene un día?", ["24", "veinticuatro"]],
  ["¿Qué animal es símbolo de la paz?", ["paloma", "la paloma"]],
  ["¿De qué color es una esmeralda?", ["verde"]],
  ["¿De qué color es un rubí?", ["rojo", "roja"]],
  ["¿De qué color es un zafiro?", ["azul"]],
  ["¿Qué deporte practicaba Manu Ginóbili?", ["basquet", "basketball", "basket", "baloncesto"]],
  ["¿Qué cantante es 'la reina del pop' y canta 'Material Girl'?", ["madonna"]],
  ["¿Qué país tiene forma de bota en Europa?", ["italia"]],
  ["¿Cómo se llama la fruta seca que se saca de la vid y se usa en el pan dulce?", ["pasa", "pasas", "pasa de uva", "pasas de uva"]],
  ["¿Qué animal cambia la piel y se arrastra sin patas?", ["serpiente", "vibora", "la serpiente"]],
];
const WORDS = ["murcielago", "computadora", "mate", "asado", "empanada", "bandoneon", "guitarra", "cordillera", "pinguino",
  "dulce de leche", "alfajor", "colectivo", "chocolate", "biblioteca", "elefante", "jirafa", "mariposa", "relampago", "tormenta",
  "medialuna", "heladera", "ventilador", "bicicleta", "astronauta", "telescopio", "dinosaurio", "laberinto", "pirata", "tesoro",
  "volcan", "galaxia", "paraguas", "caramelo", "pizza", "milanesa", "zapatilla", "teclado", "auriculares", "camiseta",
  "cancha", "arquero", "gambeta", "hinchada", "trueno", "invierno", "primavera", "dragon", "castillo", "fantasma"];


// ---------- IA: Groq (gratis, sin tarjeta) y/o Gemini ----------
// Usa la que tenga clave cargada en Render. Si están las dos, prueba primero Groq y después Gemini.
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GROQ_KEY = (process.env.GROQ_API_KEY || "").trim();
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const AI_ON = !!(GROQ_KEY || GEMINI_KEY);
const TOPICS = ["historia argentina", "geografía del mundo", "ciencia", "fútbol", "música argentina", "cine", "series", "videojuegos", "animales",
  "comida", "literatura", "historia universal", "deportes", "tecnología", "cuerpo humano", "espacio y astronomía", "rock nacional", "mitología", "arte", "idiomas"];
const recentQs = [];

let aiLastError = "";
let aiWorkingModel = "";
const GEMINI_MODELS = [...new Set([GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-flash-latest"])];
const GROQ_MODELS = [...new Set([GROQ_MODEL, "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"])];
const AI_TARGETS = [...(GROQ_KEY ? GROQ_MODELS.map((m) => ({ p: "groq", m })) : []), ...(GEMINI_KEY ? GEMINI_MODELS.map((m) => ({ p: "gemini", m })) : [])];
const targetName = (t) => `${t.p === "groq" ? "Groq" : "Gemini"} · ${t.m}`;
function explainAI(p, status, body) {
  const b = String(body || ""), who = p === "groq" ? "Groq" : "Gemini";
  if ((status === 400 && /API key not valid|API_KEY_INVALID/i.test(b)) || status === 401) return `la clave de ${who} no es válida (revisá que esté bien copiada en Render, sin espacios)`;
  if (status === 403 && /referer|referrer|BLOCKED|restricted|android|ios/i.test(b)) return `la clave de ${who} tiene restricciones. Creá una clave nueva sin restricciones`;
  if (status === 403 && /SERVICE_DISABLED|has not been used|disabled/i.test(b)) return "la API de Gemini no está habilitada en ese proyecto de Google";
  if (status === 403) return `${who} rechazó la clave (403). Probá con una clave nueva`;
  if (status === 402 || /prepay|billing|credits are depleted/i.test(b)) return `${who} pide cargar crédito`;
  if (status === 429) return `se alcanzó el límite gratis de ${who} por ahora. Probá en un rato`;
  if (status === 404 || /model_not_found|decommissioned|does not exist/i.test(b)) return "el modelo de IA no está disponible";
  if (status >= 500) return `${who} tuvo un error de su lado. Probá de nuevo`;
  return `${who} respondió un error ${status}`;
}
async function postJSON(url, headers, body, ms = 20000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (!r.ok) return { status: r.status, body: await r.text() };
    return { data: await r.json() };
  } finally { clearTimeout(to); }
}
async function callGemini(model, prompt, json, temperature) {
  const res = await postJSON(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": GEMINI_KEY },
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { ...(json ? { responseMimeType: "application/json" } : {}), temperature } });
  if (res.status) return res;
  return { text: res.data?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") || "" };
}
async function callGroq(model, prompt, json, temperature, extras = true) {
  const body = { model, messages: [{ role: "user", content: prompt }], temperature: Math.min(1.5, temperature), max_completion_tokens: 4096 };
  if (extras && json) body.response_format = { type: "json_object" };
  if (extras && /gpt-oss/.test(model)) body.reasoning_effort = "low";
  const res = await postJSON("https://api.groq.com/openai/v1/chat/completions", { Authorization: `Bearer ${GROQ_KEY}` }, body);
  // Si algún parámetro extra no le gusta (o el JSON salió mal), reintenta en modo simple
  if (res.status === 400 && extras && /reasoning|response_format|json_validate_failed|unsupported/i.test(res.body)) return callGroq(model, prompt, json, temperature, false);
  if (res.status) return res;
  return { text: res.data?.choices?.[0]?.message?.content || "" };
}
// Saca el JSON aunque venga con texto o ``` alrededor
function parseAIJson(raw) {
  const t = String(raw || "").replace(/```(json)?/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("json");
}
// Pide algo a la IA; devuelve el texto (o el objeto si json) o null
async function aiCall(prompt, json = true, temperature = 1) {
  if (!AI_ON) { aiLastError = "la IA no está activada (falta GROQ_API_KEY en Render)"; return null; }
  if (typeof fetch !== "function") { aiLastError = "la versión de Node del servidor es muy vieja"; return null; }
  const list = aiWorkingModel ? [...AI_TARGETS.filter((t) => targetName(t) === aiWorkingModel), ...AI_TARGETS.filter((t) => targetName(t) !== aiWorkingModel)] : AI_TARGETS;
  let firstErr = "";
  for (const t of list) {
    try {
      const res = t.p === "groq" ? await callGroq(t.m, prompt, json, temperature) : await callGemini(t.m, prompt, json, temperature);
      if (res.status) {
        console.error("IA", t.p, t.m, res.status, String(res.body).slice(0, 300));
        const why = explainAI(t.p, res.status, res.body);
        if (!firstErr || /modelo/.test(firstErr)) firstErr = why;
        continue; // probar el siguiente modelo / proveedor
      }
      if (!res.text.trim()) { firstErr ||= "la IA respondió vacío"; continue; }
      const out = json ? parseAIJson(res.text) : res.text.trim();
      aiWorkingModel = targetName(t); aiLastError = "";
      return out;
    } catch (e) {
      console.error("IA error:", t.p, t.m, e.message);
      firstErr ||= e.name === "AbortError" ? "la IA tardó demasiado" : e.message === "json" ? "la IA respondió algo raro" : "no se pudo conectar con la IA";
    }
  }
  aiLastError = firstErr || "la IA no respondió";
  return null;
}
// Verifica una pregunta volviéndola a responder en frío. Devuelve true (coincide), false (no coincide
// o la IA no está segura) o null (no se pudo verificar: la IA falló, aceptamos igual para no trabar el juego).
async function aiVerify(pregunta, answers) {
  const r = await aiCall(`Sos un verificador de trivia muy estricto. Respondé esta pregunta con la respuesta correcta y precisa, en 1 a 3 palabras. Si NO estás 100% seguro de la respuesta, respondé exactamente "NO SE" (no inventes). Pregunta: ${pregunta}\nDevolvé SOLO JSON: {"respuesta":"..."}`, true, 0);
  if (!r || !r.respuesta) return null; // la IA de verificación no respondió
  const a = String(r.respuesta).trim();
  if (!a || /^(no\s*se|no\s*s[eé]|ns|no estoy segur|no lo se|desconocid)/i.test(plain(a))) return false; // dudó: descartamos
  return isCorrect(plain(a), answers) ? true : false;
}
async function aiQuestion(tema, userChosen = false) {
  const prompt = `Generá UNA pregunta de trivia en español rioplatense sobre el tema "${tema}". La pregunta TIENE que ser sobre ese tema. Dificultad media, apta para un chat de amigos adultos.
La respuesta tiene que ser corta (1 a 3 palabras), indiscutible y fácil de verificar. Nada de preguntas de opinión ni con varias respuestas válidas.
MUY IMPORTANTE — la respuesta NO puede ser un año, una fecha ni un número de muchos dígitos (nadie sabe los años exactos y es aburrido ponerse a tipear números). PROHIBIDO empezar con "¿En qué año..." o "¿En qué fecha...". La respuesta tiene que ser un NOMBRE, un lugar, una persona, un animal, un objeto o una palabra (no un número). Solo se permite un número si es chico y adivinable (del 1 al 20, por ejemplo "cuántas patas tiene una araña").
Preferí preguntas CURIOSAS y entretenidas: cosas sorprendentes, récords, orígenes de palabras, apodos, "cuál es el único...", "qué animal...", "cómo se llama...", curiosidades que generen un "¡ah, mirá!". Evitá lo típico de examen escolar.
REGLA DE ORO — SOLO datos que sepas con CERTEZA ABSOLUTA. Si dudás aunque sea un poco, elegí OTRA pregunta más segura. Es mejor una pregunta fácil y correcta que una original y equivocada.
EVITÁ los datos que se confunden fácil (son la causa de los errores): qué álbum/canción es de qué artista, en qué película actuó alguien, qué autor escribió qué libro específico, estadísticas exactas, quién ganó qué premio. Si hacés una de esas, que sea SÚPER conocida (ej: "Thriller" es de Michael Jackson), nunca algo de nicho.
TEMAS DE NICHO: si el tema es un videojuego, anime, serie, cómic o fandom ESPECÍFICO (ej: Summoners War, Genshin, un anime puntual) donde NO podés garantizar que el dato sea exacto, hacé la pregunta igual sobre ese tema, pero marcá "nicho": true y sé lo más conservador posible. Para temas de conocimiento general (geografía, ciencia, historia conocida, deportes mainstream) marcá "nicho": false.
No repitas estas preguntas: ${recentQs.slice(-15).join(" | ") || "(ninguna)"}
Devolvé SOLO un JSON así: {"pregunta":"...","respuesta":"...","aceptadas":["variantes válidas de la respuesta, sin tildes, en minúscula (si es un número, también escrito en letras)"],"nicho":true o false,"pista":"una pista corta que ayude a adivinar SIN decir la respuesta ni parte de ela","dato":"un dato curioso breve sobre la respuesta"}`;
  const q = await aiCall(prompt, true, 0.5); // menos "creatividad" = menos inventos
  if (!q) return null;
  if (!q.pregunta || !q.respuesta) { aiLastError = "la IA respondió algo incompleto"; return null; }
  // Red de seguridad: descartar preguntas de año/fecha o con respuesta de números largos (aburren y nadie las sabe)
  const rawA = String(q.respuesta).trim();
  const esAnioOFecha = /^\s*(en|el|hacia|cerca de|alrededor de)?\s*(que\s+)?(a[ñn]o|fecha|siglo|d[ií]a)\b/i.test(String(q.pregunta)) || /^-?\d{3,}$/.test(plain(rawA).replace(/\D/g, "")) || /\b(1\d{3}|20\d{2})\b/.test(rawA);
  if (esAnioOFecha) { aiLastError = "pregunta de fecha descartada"; return null; }
  const answers = [...new Set([q.respuesta, ...(Array.isArray(q.aceptadas) ? q.aceptadas : [])].map((x) => plain(String(x))).filter(Boolean))];
  // ¿Es un tema de nicho (juego/anime/fandom) donde la IA puede equivocarse? Solo si el usuario eligió el tema.
  const niche = userChosen && q.nicho === true;
  // VERIFICACIÓN: en temas generales, otra consulta vuelve a responder en frío y descarta si no coincide.
  // En temas de nicho NO sirve (la IA se equivoca igual al verificar), así que no descartamos: avisamos con un cartel.
  if (!niche) {
    const check = await aiVerify(q.pregunta, answers);
    if (check === false) { aiLastError = "respuesta no verificada (posible error de la IA)"; return null; }
  }
  // la pista no puede contener la respuesta
  let pista = String(q.pista || "").slice(0, 160);
  if (answers.some((a) => a.length >= 2 && (" " + plain(pista) + " ").includes(" " + a + " "))) pista = "";
  return { q: String(q.pregunta).slice(0, 300), shown: String(q.respuesta).slice(0, 80), answers, dato: String(q.dato || "").slice(0, 250), pista, ai: true, niche };
}
// "Bolsa barajada": recorre TODO el banco (205 preguntas) antes de repetir ninguna.
let bankBag = [];
function bankQuestion() {
  if (!bankBag.length) { bankBag = TRIVIA.map((_, i) => i); for (let i = bankBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bankBag[i], bankBag[j]] = [bankBag[j], bankBag[i]]; } }
  // evitá repetir algo muy reciente (por si la IA ya lo preguntó)
  let idx = bankBag.pop();
  if (recentQs.includes(TRIVIA[idx][0]) && bankBag.length) { const k = bankBag.findIndex((i) => !recentQs.includes(TRIVIA[i][0])); if (k >= 0) { const tmp = bankBag[k]; bankBag[k] = idx; idx = tmp; } }
  const [q, answers] = TRIVIA[idx];
  return { q, shown: answers[0], answers, dato: "", ai: false };
}
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// ---- Números escritos en letras → cifras ("nueve" = "9", "mil novecientos ochenta y seis" = "1986") ----
const NUM_WORDS = (() => {
  const m = { cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
    catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22,
    veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
    sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, quinientos: 500, quinientas: 500 };
  ["dos", "tres", "cuatro", "seis", "siete", "ocho", "nove"].forEach((w, i) => { const v = [2, 3, 4, 6, 7, 8, 9][i] * 100; m[w + "cientos"] = v; m[w + "cientas"] = v; });
  return m;
})();
function numify(text) {
  const toks = String(text).split(" "), out = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (!(w in NUM_WORDS) && w !== "mil" && !/^millon(es)?$/.test(w)) { out.push(w); continue; }
    let total = 0, cur = 0, j = i;
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t === "y" && j > i && toks[j + 1] in NUM_WORDS && NUM_WORDS[toks[j + 1]] < 10) continue;
      if (t in NUM_WORDS) cur += NUM_WORDS[t];
      else if (t === "mil") { total += (cur || 1) * 1000; cur = 0; }
      else if (/^millon(es)?$/.test(t)) { total = (total + (cur || 1)) * 1e6; cur = 0; }
      else break;
    }
    out.push(String(total + cur)); i = j - 1;
  }
  return out.join(" ");
}
const stripArt = (s) => s.replace(/^(el|la|los|las|lo) /, "");
function matches(guess, ans) {
  if (!guess || !ans) return false;
  if (guess === ans) return true;
  if (/^\d+$/.test(ans)) return guess.split(" ").includes(ans);
  if (ans.length >= 4 && (" " + guess + " ").includes(" " + ans + " ")) return true;
  const tol = ans.length >= 9 ? 2 : ans.length >= 5 ? 1 : 0;
  return tol > 0 && lev(guess, ans) <= tol;
}
// Acepta la respuesta escrita distinto: "9" o "nueve", con o sin artículo, con algún error de tipeo
function isCorrect(guess, answers) {
  const g = stripArt(guess), gn = numify(g);
  return answers.some((ans) => { const a = stripArt(ans); return matches(guess, ans) || matches(g, a) || matches(gn, numify(a)); });
}
// Pistas: muestra la respuesta con huecos ("C _ _ _ _ _ R _ A"), revelando más letras de a poco
function hintMask(ans, reveal) {
  return [...ans].map((ch, i) => (/[\p{L}\p{N}]/u.test(ch) ? (reveal.has(i) ? ch.toUpperCase() : "_") : ch === " " ? "  " : ch)).join(" ");
}
function rankingText() {
  const top = [...points].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!top.length) return "🏆 Todavía nadie sumó puntos. ¡Arrancá con /trivia o /ahorcado!";
  return "🏆 Ranking:\n" + top.map(([n, p], i) => `${["🥇", "🥈", "🥉"][i] || (i + 1) + "."} ${n} — ${p} pt${p === 1 ? "" : "s"}`).join("\n");
}

// ================== Torneo semanal ==================
const WEEK = 7 * 24 * 3600000, ART = 3 * 3600000; // Argentina = UTC-3
function weekStartOf(ts) {
  const d = new Date(ts - ART); const back = (d.getUTCDay() + 6) % 7; // lunes = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back) + ART;
}
const weekly = { start: weekStartOf(Date.now()), points: new Map() };
let champions = []; // [{ nick, pts, week }]
const isChamp = (nick) => !!champions.length && champions[champions.length - 1].nick.toLowerCase() === String(nick).toLowerCase();
function weeklyText() {
  const top = [...weekly.points].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const left = weekly.start + WEEK - Date.now(), dias = Math.floor(left / 86400000), hs = Math.floor((left % 86400000) / 3600000);
  const last = champions[champions.length - 1];
  return `🏆 TORNEO SEMANAL (termina en ${dias} d ${hs} h · el lunes 0 h)\n` +
    (top.length ? top.map(([n, p], i) => `${["🥇", "🥈", "🥉"][i] || (i + 1) + "."} ${n} — ${p} pts`).join("\n") : "Nadie sumó puntos esta semana todavía. ¡Jugá trivia, dibujo o duelos!") +
    (last ? `\n👑 Campeón/a de la semana pasada: ${last.nick} (${last.pts} pts)` : "");
}
setInterval(() => {
  if (Date.now() < weekly.start + WEEK) return;
  const top = [...weekly.points].sort((a, b) => b[1] - a[1]);
  if (top.length) {
    champions.push({ nick: top[0][0], pts: top[0][1], week: weekly.start }); champions = champions.slice(-20);
    { const t = byNick(top[0][0]); if (t?.c?.pkey) achChamp(t.c); }
    io.emit("announce", { text: `🏆 ¡${top[0][0]} ganó el torneo de la semana con ${top[0][1]} puntos! Se lleva la copa 🏆 hasta el próximo lunes.`, ts: Date.now() });
    gameSay("🏁 Terminó el torneo semanal.\n" + top.slice(0, 5).map(([n, p], i) => `${["🥇", "🥈", "🥉"][i] || (i + 1) + "."} ${n} — ${p} pts`).join("\n") + "\n¡Arranca uno nuevo!");
  }
  weekly.start = weekStartOf(Date.now()); weekly.points = new Map();
  dirty(); pushUsers();
}, 60000);


// ================== Canales de voz (llamada grupal) ==================
const VOICE_ROOMS = ["voz"]; // la Sala de voz (tiene su propio chat de texto también)
const VOICE_MAX = 8;
const voice = new Map(VOICE_ROOMS.map((r) => [r, new Set()])); // sala -> socket ids
const voiceOf = (sid) => { for (const [r, set] of voice) if (set.has(sid)) return r; return null; };
function voiceList(room) { return [...voice.get(room)].map((sid) => clients.get(sid)).filter(Boolean).map((x) => ({ nick: x.nick, muted: !!x.voiceMuted })); }
function pushVoice(room) {
  const list = voiceList(room);
  if (room === "mods") emitToMods("voice-count", { room, list }); else io.emit("voice-count", { room, list });
}
function voiceLeave(sid) {
  const room = voiceOf(sid); if (!room) return;
  voice.get(room).delete(sid);
  for (const other of voice.get(room)) io.to(other).emit("voice-peer-leave", { sid });
  io.to(sid).emit("voice-left", { room });
  pushVoice(room);
}


// ================== Decidí por mí (votaciones) ==================
const polls = new Map(); // id -> { room, author, question, options, votes: Map, endsAt, timer }
const pollCounts = (p) => p.options.map((_, i) => [...p.votes.values()].filter((v) => v === i).length);
function endPoll(id) {
  const p = polls.get(id); if (!p) return;
  polls.delete(id); clearTimeout(p.timer);
  const counts = pollCounts(p), total = counts.reduce((a, b) => a + b, 0);
  io.emit("poll-end", { id, counts });
  if (p.onEnd) return p.onEnd(counts, total);
  if (!total) return botSay(`⚖️ «${p.question}» — nadie votó 🤷`, p.room);
  const max = Math.max(...counts), top = p.options.filter((_, i) => counts[i] === max);
  botSay(top.length > 1
    ? `⚖️ Veredicto de «${p.question}»: ¡EMPATE entre ${top.join(" y ")}! (${max} voto${max === 1 ? "" : "s"} cada una) 🤝`
    : `⚖️ Veredicto de «${p.question}»: ¡${top[0].toUpperCase()}! (${max} de ${total} voto${total === 1 ? "" : "s"})`, p.room);
}

// ================== Motores de juego: uno por cada sub-sala de 🎮 Juegos ==================
// Cada sub-sala tiene su propio "Crupier" y su propio juego en curso, así se puede jugar en paralelo.
function makeEngine(ROOM, KIND) {
  const gameSay = (text) => botSay(text, ROOM, CRUPIER);
  let game = null; // juego activo en la sala

  function endGame() { if (game?.timer) clearTimeout(game.timer); const g = game; game = null; if (g?.cleanup) g.cleanup(); }

  let triviaRound = null; // { left, total, temas: [], scores: Map }
  const roundTema = () => triviaRound?.temas.length ? triviaRound.temas[(triviaRound.total - triviaRound.left) % triviaRound.temas.length] : "";

  async function startTrivia(tema) {
    game = { type: "cargando" };
    const t = tema || pick(TOPICS);
    const custom = triviaRound?.custom?.length ? triviaRound.custom.shift() : null;
    let q = custom ? { q: custom.q, shown: custom.a[0], answers: custom.a.map(plain).filter(Boolean), dato: "", ai: false, custom: true } : await aiQuestion(t, !!tema);
    if (!q && !custom) q = await aiQuestion(t, !!tema); // un reintento (por si descartó una pregunta de fecha)
    if (!q) {
      q = bankQuestion();
      if (tema) gameSay(`⚠️ No pude hacer una pregunta de "${tema}": ${aiLastError}. Va una general.`);
    }
    recentQs.push(q.q); if (recentQs.length > 40) recentQs.shift();
    const n = triviaRound ? `[${triviaRound.total - triviaRound.left + 1}/${triviaRound.total}] ` : "";
    const secs = triviaRound?.secs || 40;
    game = { type: "trivia", answers: q.answers, shown: q.shown, dato: q.dato, only: triviaRound?.duel ? [triviaRound.duel.a, triviaRound.duel.b] : null, excl: triviaRound?.creator || null,
      timer: setTimeout(() => finishTrivia(null), secs * 1000), hints: 0, hintTimers: [], startAt: now(), cleanup() { this.hintTimers.forEach(clearTimeout); } };
    if (triviaRound?.hints !== false) scheduleHints(game, q, secs);
    gameSay(`❓ ${triviaRound?.duel ? `⚔️ DUELO ${triviaRound.duel.a} vs ${triviaRound.duel.b} ` : "TRIVIA "}${n}${q.custom ? `✍️ de ${triviaRound.creator} ` : ""}${q.ai ? "🤖 " : ""}(${q.ai ? t + " · " : ""}${secs} s)${q.niche ? "\n⚠️ Tema de nicho: la respuesta puede no ser exacta." : ""}\n${q.q}\n${triviaRound?.duel ? "Solo responden los dos del duelo." : q.custom ? `Escribí la respuesta en el chat (${triviaRound.creator} no juega: la sabe 😉).` : "Escribí la respuesta en el chat."}`);
  }
  // El Crupier tira 2 pistas: a un tercio y a dos tercios del tiempo. Cada pista baja 1 punto el premio.
  function scheduleHints(g, q, secs) {
    const ans = String(q.shown || "").trim();
    const isNum = /^\d{1,9}$/.test(ans.replace(/[.,\s]/g, ""));
    const idx = [...ans].map((ch, i) => (/[\p{L}\p{N}]/u.test(ch) ? i : -1)).filter((i) => i >= 0);
    const reveal = new Set();
    [...ans].forEach((ch, i) => { if (/[\p{L}\p{N}]/u.test(ch) && (i === 0 || /\s/.test(ans[i - 1]))) reveal.add(i); });
    const pistas = [];
    if (isNum) {
      const n = parseInt(ans.replace(/[.,\s]/g, "")), digits = String(n).length;
      pistas.push(q.pista ? `${q.pista} (es un número de ${digits} cifra${digits === 1 ? "" : "s"})` : `Es un número de ${digits} cifra${digits === 1 ? "" : "s"}.`);
      const span = Math.max(3, Math.round(n * 0.15)), lo = Math.max(0, n - Math.floor(Math.random() * span) - 1);
      pistas.push(`Está entre ${lo} y ${lo + span + 1}.`);
    } else {
      const letras = idx.length, palabras = ans.split(/\s+/).length;
      pistas.push(`${q.pista ? q.pista + "\n" : ""}${palabras > 1 ? `Son ${palabras} palabras` : `Tiene ${letras} letras`}: ${hintMask(ans, reveal)}`);
      const rest = shuffle(idx.filter((i) => !reveal.has(i)));
      const more = new Set([...reveal, ...rest.slice(0, Math.max(1, Math.floor(rest.length * 0.4)))]);
      if (letras > 3) pistas.push(hintMask(ans, more));
    }
    pistas.forEach((p, k) => g.hintTimers.push(setTimeout(() => {
      if (game !== g) return;
      g.hints = k + 1;
      gameSay(`💡 Pista ${k + 1}: ${p}\n(ahora vale ${Math.max(1, 3 - g.hints)} punto${3 - g.hints === 1 ? "" : "s"})`);
    }, secs * 1000 * (k === 0 ? 0.35 : 0.65))));
  }
  function finishTrivia(winner) {
    const g = game; endGame();
    const extra = g.dato ? `\n💡 ${g.dato}` : "";
    if (winner) {
      const pts = Math.max(1, 3 - (g.hints || 0));
      addPoints(winner, pts);
      bumpNick(winner, "trivia", 1, { xp: 5, capKey: "game", cap: 200 });
      if (!g.hints && now() - g.startAt < 6000) bumpNick(winner, "fast", 1);
      if (triviaRound) triviaRound.scores.set(winner, (triviaRound.scores.get(winner) || 0) + 1);
      if (triviaRound?.duel) triviaRound.duel.scores[winner] = (triviaRound.duel.scores[winner] || 0) + 1;
      gameSay(`✅ ¡${winner} acertó! Era: ${g.shown}. +${pts} pt${pts === 1 ? "" : "s"}${g.hints ? ` (con ${g.hints} pista${g.hints === 1 ? "" : "s"})` : ""} (total: ${points.get(winner)})${extra}`);
    } else gameSay(`⏰ ¡Tiempo! Nadie acertó. Era: ${g.shown}${extra}`);
    if (triviaRound) {
      triviaRound.left--;
      if (triviaRound.left > 0) {
        if (triviaRound.left % 5 === 0) gameSay(`📊 Van ${triviaRound.total - triviaRound.left}/${triviaRound.total}. ` + ([...triviaRound.scores].sort((a, b) => b[1] - a[1]).map(([n, p]) => `${n}: ${p}`).join(" · ") || "Nadie sumó todavía"));
        setTimeout(() => { if (!game && triviaRound) startTrivia(roundTema()); }, 4000);
      }
      else if (triviaRound.duel) {
        const { a, b, id } = triviaRound.duel; triviaRound = null;
        endDuelTrivia(id, a, b);
      }
      else {
        const res = [...triviaRound.scores].sort((a, b) => b[1] - a[1]);
        triviaRound = null;
        gameSay(res.length ? `🏁 Fin de la ronda. Ganador/a: ${res[0][0]} con ${res[0][1]} acierto${res[0][1] === 1 ? "" : "s"}!\n` + res.map(([n, p]) => `${n}: ${p}`).join(" · ") : "🏁 Fin de la ronda. Nadie acertó ninguna 😅");
      }
    }
  }

  const hangView = () => game.word.split("").map((ch) => ch === " " ? "  " : game.found.has(ch) ? ch.toUpperCase() : "_").join(" ");
  const GALLOWS = ["😀", "😐", "😕", "😟", "😨", "😱", "💀"];

  function gameCommand(c, id, cmd, arg) {
    if (cmd !== "ranking" && juegosBanNotice(c, id)) return;
    if (CMD_KIND[cmd] && CMD_KIND[cmd] !== KIND) return notice(id, `🎮 Ese juego se juega en la sala ${ROOM_LABEL[CMD_KIND[cmd]]} (en la lista, adentro de 🎮 Juegos).`, "help");
    switch (cmd) {
      case "ia": {
        if (!AI_ON) return gameSay("🤖 IA: ❌ desactivada. Falta cargar GROQ_API_KEY en Render → Environment.");
        gameSay("🤖 Probando la IA…");
        return aiQuestion("cultura general").then((q) => gameSay(q
          ? `🤖 IA: ✅ funciona (${aiWorkingModel}). Probá /trivia química`
          : `🤖 IA: ❌ falla: ${aiLastError}.`));
      }
      case "juegos":
        return notice(id, `🎮 ${ROOM_LABEL[KIND]} (o usá los botones de abajo)\n${GAME_HELP[KIND]}\n📊 /ranking · 🏳️ /rendirse · 🤖 /ia\n` +
          `Las otras salas: ${Object.entries(ROOM_LABEL).filter(([k]) => k !== KIND).map(([, v]) => v).join(" · ")}`, "help");
      case "ranking":
        return gameSay(rankingText());
      case "torneo":
        return gameSay(weeklyText());
      case "quienesia": case "turing":
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        return startTuring(c.nick, Math.min(6, Math.max(2, parseInt(arg) || 3)));
      case "mentiroso":
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        return startMentiroso(c.nick, Math.min(8, Math.max(1, parseInt(arg) || 3)));
      case "impostor": {
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        const pr = arg.split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
        return startImpostor(c.nick, pr.length === 2 ? pr : null);
      }
      case "asesinato":
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        return startAsesinato(c.nick, arg.slice(0, 60));
      case "100rotos": case "rotos": {
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        return startRotos(c.nick, Math.min(10, Math.max(1, parseInt(arg) || 5)));
      }
      case "juicio": {
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        const [who, ...cargo] = arg.replace(/^@/, "").split(" ");
        return startJuicio(c, id, who, cargo.join(" "));
      }
      case "eliminatorio": {
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        return startBracket(c.nick);
      }
      case "llaves": return gameSay(bracketText());
      case "vor": case "verdadoreto": {
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        return startVor(c.nick, vorParse(arg));
      }
      case "dibujo": {
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        const rondas = Math.min(10, Math.max(1, parseInt(arg) || 5));
        return startPictionary(c, rondas);
      }
      case "rendirse":
        if (!game || game.type === "cargando") return notice(id, "No hay ningún juego en curso.");
        if (game.type === "llaves" && game.starter !== c.nick && !c.admin) return notice(id, "Solo quien arrancó el torneo (o un moderador) lo puede cancelar.");
        if (triviaRound?.duel) {
          if (![triviaRound.duel.a, triviaRound.duel.b].includes(c.nick) && !c.admin) return notice(id, "Es un duelo: solo lo pueden cortar ellos dos.");
          const d = duels.get(triviaRound.duel.id); if (d) duelExpire(d);
        }
        { const g = game; endGame(); triviaRound = null;
          if (["turing", "mentiroso", "impostor", "asesinato"].includes(g.type)) return gameSay(`🏳️ ${c.nick} cortó el juego.${g.type === "turing" && g.aiAlias ? ` (La IA era ${g.aiAlias} 🤖)` : g.type === "impostor" && g.impostor ? ` (El impostor era ${g.impostor})` : g.type === "asesinato" && g.culprit ? ` (El asesino era ${g.culprit})` : ""}`);
          if (g.type === "rotos") return gameSay(`🏳️ ${c.nick} cortó 100 rotos dicen.`);
          if (g.type === "quiendijo") return gameSay(`🏳️ ${c.nick} cortó ¿Quién dijo esto?${g.cur ? ` (Esa la dijo ${g.cur.by})` : ""}`);
          if (g.type === "juicio") return gameSay(`🏳️ ${c.nick} suspendió el juicio. ¡Se levanta la sesión!`);
          if (g.type === "llaves") return gameSay(`🏳️ ${c.nick} canceló el torneo eliminatorio.`);
          if (g.type === "vor") return gameSay(`🏳️ ${c.nick} terminó Verdad o reto. ¡Gracias por jugar!`);
          if (g.type === "dibujo") return gameSay(`🏳️ ${c.nick} cortó el juego. La palabra era: ${g.word.toUpperCase()}`);
          return gameSay(`🏳️ ${c.nick} cortó el juego. ${g.type === "trivia" ? `La respuesta era: ${g.shown}` : `La palabra era: ${g.word.toUpperCase()}`}`); }
      case "quiendijo": {
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        return startQuienDijo(c.nick, Math.max(1, parseInt(arg) || 5));
      }
      case "trivia": case "ahorcado":
        if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
        if (cmd === "trivia") {
          let tema = arg.trim();
          if (/^ronda\b/i.test(tema)) {
            tema = tema.replace(/^ronda\s*/i, "");
            const m = tema.match(/^(\d+)\s*/);
            const total = Math.min(30, Math.max(3, m ? parseInt(m[1]) : 5));
            if (m) tema = tema.slice(m[0].length);
            const temas = tema.split(/\s*[,;]\s*|\s+y\s+/).map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 6);
            triviaRound = { left: total, total, temas, scores: new Map() };
            gameSay(`🏁 ${c.nick} arrancó una RONDA de ${total} preguntas${temas.length ? " sobre " + temas.join(", ") : ""}. ¡Atentos!`);
            return startTrivia(roundTema());
          }
          return startTrivia(tema.slice(0, 60));
        }
        game = { type: "ahorcado", word: pick(WORDS), found: new Set(), wrong: [], timer: setTimeout(() => { const g = game; endGame(); gameSay(`⏰ Se terminó el tiempo. La palabra era ${g.word.toUpperCase()}`); }, 5 * 60000) };
        return gameSay(`🪢 AHORCADO\n${hangView()}\nEscribí una letra o arriesgá la palabra entera. Tienen 6 vidas.`);
    }
  }

  // Revisa cada mensaje de la sala Juegos por si es una respuesta
  function gameGuess(nick, text) {
    if (!game) return;
    const t = plain(text);
    if (!t) return;
    if (game.type === "quiendijo") return qdGuess(nick, t);
    if (game.type === "trivia") {
      if (game.only && !game.only.includes(nick)) return;
      if (game.excl === nick) return;
      if (isCorrect(t, game.answers)) finishTrivia(nick);
      return;
    }
    if (game.type === "vor") return vorGuess(nick, t);
    if (["turing", "impostor", "asesinato"].includes(game.type)) return inscriptionGuess(nick, t);
    if (game.type === "llaves") {
      if (game.phase === "inscripcion" && /^(yo|me anoto|yo juego)$/.test(t) && !game.players.has(nick)) {
        if (game.players.size >= 16) return gameSay("🏟️ Ya hay 16 anotados, ¡cupo lleno!");
        game.players.add(nick); gameSay(`✍️ ${nick} se anotó (${game.players.size}).`);
      }
      return;
    }
    if (game.type === "ahorcado") {
      if (game.excl === nick) return;
      const word = plain(game.word);
      if (t === word) { const w = game.word; endGame(); addPoints(nick, 3); bumpNick(nick, "trivia", 1, { xp: 5, capKey: "game", cap: 200 }); return gameSay(`🎉 ¡${nick} adivinó la palabra: ${w.toUpperCase()}! +3 pts`); }
      if (!/^[a-zñ]$/.test(t)) return;
      if (game.found.has(t) || game.wrong.includes(t)) return gameSay(`La "${t.toUpperCase()}" ya se dijo.`);
      const lives = game.lives || 6, face = () => GALLOWS[Math.min(6, Math.round(game.wrong.length * 6 / lives))];
      if (word.includes(t)) {
        game.found.add(t);
        if (word.replace(/ /g, "").split("").every((ch) => game.found.has(ch))) { const w = game.word; endGame(); addPoints(nick, 2); bumpNick(nick, "trivia", 1, { xp: 5, capKey: "game", cap: 200 }); return gameSay(`🎉 ¡Completaron la palabra: ${w.toUpperCase()}! ${nick} puso la última letra (+2 pts)`); }
        return gameSay(`✔️ ¡Está la ${t.toUpperCase()}!\n${hangView()}\n${face()} Vidas: ${lives - game.wrong.length}${game.wrong.length ? " · Erradas: " + game.wrong.join(" ").toUpperCase() : ""}`);
      }
      game.wrong.push(t);
      if (game.wrong.length >= lives) { const w = game.word; endGame(); return gameSay(`💀 ¡Ahorcados! La palabra era ${w.toUpperCase()}`); }
      return gameSay(`❌ No está la ${t.toUpperCase()}.\n${hangView()}\n${face()} Vidas: ${lives - game.wrong.length} · Erradas: ${game.wrong.join(" ").toUpperCase()}`);
    }
  }

  // ================== Dibujá y adiviná ==================
  const PIC_WORDS = ["perro", "gato", "casa", "sol", "luna", "arbol", "auto", "bicicleta", "pelota", "mate", "empanada", "pizza", "guitarra", "barco", "avion",
    "pez", "flor", "nube", "lluvia", "paraguas", "anteojos", "zapato", "sombrero", "reloj", "telefono", "computadora", "libro", "lapiz", "silla", "mesa",
    "cama", "puerta", "ventana", "llave", "corazon", "estrella", "montaña", "playa", "isla", "volcan", "cohete", "robot", "fantasma", "dragon", "castillo",
    "corona", "espada", "tesoro", "pirata", "conejo", "elefante", "jirafa", "serpiente", "araña", "mariposa", "abeja", "caracol", "tortuga", "pinguino", "leon",
    "banana", "manzana", "helado", "torta", "hamburguesa", "pan", "huevo", "taza", "botella", "cuchara", "tijera", "martillo", "escalera", "puente", "tren",
    "colectivo", "semaforo", "faro", "carpa", "fogata", "globo", "regalo", "camara", "auriculares", "television", "microfono", "dinosaurio", "unicornio", "sirena", "bruja"];
  const recentPlayers = new Map(); // apodo -> última vez que habló en Juegos
  let pic = null; // ronda actual de dibujo (además de game)
  function picMask(word, revealed) { return word.split("").map((ch, i) => ch === " " ? " " : revealed.has(i) ? ch.toUpperCase() : "_").join(" "); }
  function picState() {
    if (!game || game.type !== "dibujo") return { active: false };
    return { active: true, drawer: game.drawer, mask: picMask(game.word, game.revealed), endsAt: game.endsAt, round: game.round, total: game.total };
  }
  function startPictionary(starter, total, words, secs) {
    game = { type: "dibujo", total, round: 0, words: words?.length ? words : null, secs: secs || 90, excl: words?.length ? starter.nick : null, scores: new Map(), drawer: starter.nick, word: "", revealed: new Set(), pieces: [], timers: [],
      cleanup() { this.timers.forEach(clearTimeout); io.emit("pic-state", { active: false }); } };
    gameSay(`🖍️ DIBUJÁ Y ADIVINÁ — ${total} ronda${total === 1 ? "" : "s"} de ${game.secs} s${game.words ? ` · palabras elegidas por ${starter.nick} (no adivina: las conoce 😉)` : ""}. El que dibuja recibe una palabra secreta; los demás adivinan escribiendo en el chat.\nAdivinar: +2 · El que dibuja: +1 si alguien adivina.`);
    nextPicRound(starter.nick);
  }
  function nextPicRound(drawer) {
    if (!game || game.type !== "dibujo") return;
    game.timers.forEach(clearTimeout); game.timers = [];
    game.round++;
    const used = game.used || (game.used = new Set());
    const bank = game.words || PIC_WORDS;
    const pool = bank.filter((w) => !used.has(w));
    game.word = pick(pool.length ? pool : bank); used.add(game.word);
    const ms = game.secs * 1000;
    game.drawer = drawer; game.revealed = new Set(); game.pieces = []; game.endsAt = now() + ms;
    const d = byNick(drawer);
    if (d) io.to(d.id).emit("pic-word", game.word);
    io.emit("pic-board", []);
    io.emit("pic-state", picState());
    gameSay(`🖍️ Ronda ${game.round}/${game.total}: dibuja ${drawer}. Palabra de ${game.word.replace(/ /g, "").length} letras: ${picMask(game.word, game.revealed)}\n¡Escriban sus respuestas! (${game.secs} s)`);
    const reveal = () => {
      if (!game || game.type !== "dibujo") return;
      const hidden = [...game.word].map((ch, i) => i).filter((i) => game.word[i] !== " " && !game.revealed.has(i));
      if (hidden.length > 2) { game.revealed.add(pick(hidden)); io.emit("pic-state", picState()); gameSay(`💡 Pista: ${picMask(game.word, game.revealed)}`); }
    };
    game.timers.push(setTimeout(reveal, ms * 0.45), setTimeout(reveal, ms * 0.72), setTimeout(() => endPicRound(null), ms));
  }
  function endPicRound(winner) {
    if (!game || game.type !== "dibujo") return;
    game.timers.forEach(clearTimeout); game.timers = [];
    const word = game.word.toUpperCase(), drawer = game.drawer;
    if (winner) {
      addPoints(winner, 2); addPoints(drawer, 1);
      bumpNick(drawer, "drawn", 1, { xp: 5, capKey: "game", cap: 200 }); bumpNick(winner, "guessed", 1, { xp: 3, capKey: "game", cap: 200 });
      game.scores.set(winner, (game.scores.get(winner) || 0) + 2); game.scores.set(drawer, (game.scores.get(drawer) || 0) + 1);
      gameSay(`✅ ¡${winner} adivinó! Era ${word}. +2 para ${winner} y +1 para ${drawer} 🎨`);
    } else gameSay(`⏰ ¡Tiempo! Nadie adivinó. Era ${word}.`);
    if (game.round >= game.total) {
      const res = [...game.scores].sort((a, b) => b[1] - a[1]);
      gameSay(res.length ? `🏁 Fin del dibujo. Ganó ${res[0][0]} con ${res[0][1]} pts.\n` + res.map(([n, p]) => `${n}: ${p}`).join(" · ") : "🏁 Fin del dibujo. ¡Nadie sumó! 😅");
      return endGame();
    }
    // Próximo dibujante: el que adivinó, o alguien activo en Juegos, o el mismo
    const t = now();
    const active = [...recentPlayers].filter(([n, ts]) => t - ts < 10 * 60000 && n !== drawer && byNick(n)).map(([n]) => n);
    const next = (winner && byNick(winner) ? winner : null) || (active.length ? pick(active) : null) || (byNick(drawer) ? drawer : null);
    if (!next) { gameSay("No queda nadie para dibujar. Fin del juego."); return endGame(); }
    io.emit("pic-state", { active: true, drawer: next, mask: "…", endsAt: t + 4000, round: game.round + 1, total: game.total, waiting: true });
    game.timers.push(setTimeout(() => nextPicRound(next), 4000));
  }
  // Devuelve true si el mensaje no se tiene que publicar (respuesta correcta o el dibujante diciendo la palabra)
  function picIntercept(c, sid, text) {
    if (!game || game.type !== "dibujo" || !game.word) return false;
    const t = plain(text), w = plain(game.word);
    if (c.nick === game.drawer) {
      if (t.includes(w)) { notice(sid, "🤫 ¡No vale decir la palabra! Dibujala.", "warn"); return true; }
      return false;
    }
    if (game.excl === c.nick) { if ((" " + t + " ").includes(" " + w + " ")) { notice(sid, "🤫 ¡Vos elegiste las palabras! No vale 😉", "warn"); return true; } return false; }
    if (t === w || (" " + t + " ").includes(" " + w + " ")) { endPicRound(c.nick); return true; }
    if (w.length >= 5 && lev(t, w) === 1) { notice(sid, "🔥 ¡Casi! Estás muy cerca.", "help"); return true; }
    return false;
  }

  // ================== Verdad o reto (las verdades y retos los inventan los jugadores) ==================
  // Penalización configurable para quien no cumple, pasa sin comodín o se va en su turno.
  const VOR_PEN_TYPES = ["juegos", "silencio", "chat", "puntos", "nada"];
  const VOR_DEFAULT = { type: "juegos", mins: 5, pts: 3, free: 1, vote: true, doSecs: 180 };
  function vorParse(arg) {
    const pen = { ...VOR_DEFAULT };
    const a = plain(arg || "");
    if (/\b(sin|nada|suave|tranqui)\b/.test(a)) pen.type = "nada";
    else if (/\b(silencio|silenciar|mute|mudo)\b/.test(a)) pen.type = "silencio";
    else if (/\b(chat|todo|echar|expulsion|afuera)\b/.test(a)) pen.type = "chat";
    else if (/\b(puntos?|pts)\b/.test(a)) pen.type = "puntos";
    const n = parseInt((a.match(/\d+/) || [])[0]);
    if (n > 0) { if (pen.type === "puntos") pen.pts = Math.min(20, n); else pen.mins = Math.min(60, n); }
    const cm = a.match(/comodin(?:es)?\s*(\d)/); if (cm) pen.free = Math.min(5, +cm[1]);
    return pen;
  }
  function vorPenDesc(p) {
    if (p.type === "nada") return "sin castigo 🫶";
    if (p.type === "puntos") return `📉 -${p.pts} pts en el ranking`;
    if (p.type === "silencio") return `🔇 silencio en todo el chat por ${p.mins} min`;
    if (p.type === "chat") return `🚪 ban de TODO el chat por ${p.mins} min`;
    return `⛔ ban de 🎮 Juegos por ${p.mins} min`;
  }
  function vorNames() { return [...game.players].join(", "); }
  function startVor(starter, pen = { ...VOR_DEFAULT }) {
    game = { type: "vor", phase: "join", players: new Set([starter]), turns: 0, last: "", lastAsker: "", timers: [], pen, passes: new Map(),
      cleanup() { this.timers.forEach(clearTimeout); } };
    const doMin = Math.round(pen.doSecs / 60);
    const reglas = pen.type === "nada"
      ? `Si no querés hacer algo, escribís "paso" y listo.`
      : `⚖️ CASTIGO por no cumplir, pasar o irte en tu turno: ${vorPenDesc(pen)}.\n🃏 Comodines: ${pen.free ? `${pen.free} "paso" gratis por persona` : "ninguno"}.\n⏱️ Tiempo para cumplir: ${doMin} min.${pen.vote ? `\n🗳️ Cuando digas "listo", el grupo vota si cumpliste de verdad.` : ""}`;
    gameSay(`🎭 VERDAD O RETO — ${starter} arrancó una partida.\n✋ Escriban "yo" para sumarse (25 s).\nEn cada turno, alguien del grupo inventa la verdad o el reto.\n${reglas}`);
    game.timers.push(setTimeout(() => {
      if (!game || game.type !== "vor") return;
      if (game.players.size < 2) { gameSay("🎭 Se necesitan al menos 2 para jugar. Partida cancelada."); return endGame(); }
      gameSay(`🎭 ¡Arrancamos! Juegan: ${vorNames()}. (Pueden sumarse en cualquier momento escribiendo "yo")`);
      vorNext();
    }, 25000));
  }
  function vorClear() { game.timers.forEach(clearTimeout); game.timers = []; }
  const vorFreeLeft = (nick) => Math.max(0, game.pen.free - (game.passes.get(nick) || 0));
  // Aplica el castigo elegido. cRef sirve cuando la persona ya se desconectó.
  function vorPenalize(nick, why, cRef) {
    const p = game.pen, t = byNick(nick), c = t?.c || cRef;
    if (p.type === "nada") return gameSay(`🙅 ${nick} ${why}. Sin castigo esta vez 🫶`);
    let type = p.type;
    if (type === "chat" && c?.admin) type = "juegos"; // a los mods no se los echa del chat (tienen que poder moderar)
    if (type === "puntos") {
      addPoints(nick, -p.pts);
      return gameSay(`⚖️ ${nick} ${why}.\n📉 CASTIGO: -${p.pts} pts en el ranking.`);
    }
    if (type === "silencio") {
      if (c) { c.mutedUntil = Math.max(c.mutedUntil, now() + p.mins * 60000); if (t) { voiceLeave(t.id); notice(t.id, `🔇 Penalización de Verdad o reto: no podés escribir por ${p.mins} min.`, "warn"); } }
      return gameSay(`⚖️ ${nick} ${why}.\n🔇 CASTIGO: silenciado/a en todo el chat por ${p.mins} min.`);
    }
    if (type === "chat") {
      gameSay(`⚖️ ${nick} ${why}.\n🚪 CASTIGO: afuera de TODO el chat por ${p.mins} min. ¡Chau! 👋`);
      const until = now() + p.mins * 60000;
      penKeys(c, nick).forEach((k) => chatPenalties.set(k, until));
      game.players.delete(nick);
      if (c) { c.gone = true; if (c.away && t) setTimeout(() => finalLeave(c, t.id), 400); }
      if (t) { io.to(t.id).emit("kicked", { reason: `Penalización de Verdad o reto: ${p.mins} min afuera del chat.`, ban: true, mins: p.mins }); setTimeout(() => io.sockets.sockets.get(t.id)?.disconnect(true), 400); }
      return;
    }
    const until = now() + p.mins * 60000;
    penKeys(c, nick).forEach((k) => juegosBans.set(k, until));
    game.players.delete(nick);
    if (t) io.to(t.id).emit("juegos-ban", { until, reason: "Verdad o reto" });
    gameSay(`⚖️ ${nick} ${why}.\n⛔ CASTIGO: ban de 🎮 Juegos por ${p.mins} min.`);
  }
  function vorNext() {
    if (!game || game.type !== "vor") return;
    vorClear();
    for (const n of [...game.players]) if (!byNick(n)) game.players.delete(n);
    if (game.players.size < 2) { gameSay("🎭 Quedan menos de 2 jugadores. ¡Fin de Verdad o reto!"); return endGame(); }
    if (game.turns >= 30) { gameSay("🎭 ¡Fin de la partida de Verdad o reto! Gracias por jugar 🫶"); return endGame(); }
    game.turns++;
    const here = (n) => !byNick(n)?.c?.away; // los que tienen el chat minimizado no reciben turno
    const all = [...game.players].filter((n) => n !== game.last);
    const options = all.filter(here).length ? all.filter(here) : all;
    game.current = pick(options); game.last = game.current; game.phase = "choose"; game.kind = ""; game.asker = "";
    const t = byNick(game.current);
    if (t) io.to(t.id).emit("vor-choose", { free: vorFreeLeft(game.current), pen: game.pen.type === "nada" ? "" : vorPenDesc(game.pen) });
    gameSay(`🎭 Turno ${game.turns}: le toca a ${game.current}. ¿VERDAD 🗣️ o RETO 🔥? (escribí "verdad" o "reto")`);
    game.timers.push(setTimeout(() => vorPick(pick(["verdad", "reto"]), true), 45000));
  }
  function vorPick(kind, auto) {
    if (!game || game.type !== "vor" || game.phase !== "choose") return;
    vorClear();
    game.kind = kind; game.phase = "asking";
    const others0 = [...game.players].filter((n) => n !== game.current && byNick(n));
    const others = others0.filter((n) => !byNick(n).c.away).length ? others0.filter((n) => !byNick(n).c.away) : others0;
    const fresh = others.filter((n) => n !== game.lastAsker);
    game.asker = pick(fresh.length ? fresh : others); game.lastAsker = game.asker;
    const que = kind === "verdad" ? "la pregunta 🗣️" : "el reto 🔥";
    const t = byNick(game.asker); if (t) io.to(t.id).emit("vor-ask", { target: game.current, kind });
    gameSay(`${auto ? `⏰ ${game.current} no eligió a tiempo: va ` : `${game.current} eligió `}${kind === "verdad" ? "🗣️ VERDAD" : "🔥 RETO"}.\n✍️ ${game.asker}, inventá ${que} para ${game.current}. Escribilo acá en el chat (60 s).`);
    game.timers.push(setTimeout(() => {
      if (!game || game.type !== "vor" || game.phase !== "asking") return;
      game.phase = "asking-open";
      gameSay(`⏰ ${game.asker} no escribió. ¡Cualquiera puede inventar ${que} para ${game.current}! El primero que escriba gana (30 s).`);
      game.timers.push(setTimeout(() => { if (game?.type === "vor" && game.phase === "asking-open") { gameSay("🤷 Nadie inventó nada. Pasamos al siguiente turno."); vorNext(); } }, 30000));
    }, 60000));
  }
  // El mensaje de quien inventa se convierte en la verdad o el reto (no se publica dos veces)
  function vorIntercept(c, sid, text) {
    if (!game || game.type !== "vor") return false;
    const writer = (game.phase === "asking" && c.nick === game.asker) || (game.phase === "asking-open" && c.nick !== game.current && game.players.has(c.nick));
    if (!writer) return false;
    const t = plain(text);
    if (["yo", "verdad", "reto", "listo", "paso"].includes(t)) return false;
    if (text.trim().length < 4) { notice(sid, "✍️ Escribí algo un poco más largo 😉", "help"); return true; }
    vorClear();
    game.phase = "doing";
    const secs = game.pen.doSecs, nick = game.current;
    const pasoTxt = game.pen.type === "nada" ? `(o "paso" si no querés)` : vorFreeLeft(nick) ? `("paso" usa tu comodín 🃏)` : `(si pasás: ${vorPenDesc(game.pen)})`;
    gameSay(`${game.kind === "verdad" ? "🗣️ VERDAD" : "🔥 RETO"} de ${c.nick} para ${nick}:\n«${text.trim().slice(0, 300)}»\n${nick}, tenés ${Math.round(secs / 60)} min. Cuando termines escribí "listo" ${pasoTxt}.`);
    game.timers.push(setTimeout(() => {
      if (game?.type !== "vor" || game.phase !== "doing" || game.current !== nick) return;
      gameSay(`⏰ Se terminó el tiempo de ${nick}.`);
      vorPenalize(nick, "no cumplió a tiempo"); game.phase = "next"; game.timers.push(setTimeout(vorNext, 2500));
    }, secs * 1000));
    if (secs >= 90) game.timers.push(setTimeout(() => { if (game?.type === "vor" && game.phase === "doing" && game.current === nick) gameSay(`⏳ ${nick}, te queda 1 minuto.`); }, (secs - 60) * 1000));
    return true;
  }
  function vorDone(nick) {
    vorClear();
    const others = [...game.players].filter((n) => n !== nick && byNick(n));
    if (!game.pen.vote || game.pen.type === "nada" || !others.length) { gameSay(`👏 ¡Bien ${nick}!`); bumpNick(nick, "retos", 1, { xp: 6, capKey: "game", cap: 200 }); game.phase = "next"; return game.timers.push(setTimeout(vorNext, 2500)); }
    game.phase = "vote";
    const que = game.kind === "verdad" ? "respondió la verdad" : "cumplió el reto";
    gamePoll(`🗳️ ¿${nick} ${que} de verdad?`, ["✅ Cumplió", "❌ Trucho"], 20, (counts) => {
      if (game?.type !== "vor" || game.phase !== "vote" || game.current !== nick) return;
      if (counts[1] > counts[0]) vorPenalize(nick, `no convenció al grupo (${counts[1]} a ${counts[0]})`);
      else { gameSay(`👏 ¡Aprobado/a! ${nick} cumplió${counts[0] ? ` (${counts[0]} a ${counts[1]})` : ""}.`); bumpNick(nick, "retos", 1, { xp: 6, capKey: "game", cap: 200 }); }
      game.phase = "next"; game.timers.push(setTimeout(vorNext, 2500));
    }, [nick]);
  }
  function vorPass(nick) {
    vorClear(); game.phase = "next";
    if (game.pen.type === "nada") gameSay(`🙅 ${nick} pasó. Sin drama 🫶`);
    else if (vorFreeLeft(nick) > 0) {
      game.passes.set(nick, (game.passes.get(nick) || 0) + 1);
      const left = vorFreeLeft(nick);
      gameSay(`🃏 ${nick} usó un comodín y pasó sin castigo. ${left ? `Le queda${left === 1 ? "" : "n"} ${left}.` : "Ya no le quedan: la próxima, castigo."}`);
    } else vorPenalize(nick, "pasó sin comodines");
    game.timers.push(setTimeout(vorNext, 2500));
  }
  function vorGuess(nick, t) {
    if (t === "yo" || t === "yo juego" || t === "me sumo") {
      if (!game.players.has(nick)) { game.players.add(nick); gameSay(`✋ ${nick} se sumó. Juegan: ${vorNames()}`); }
      return;
    }
    if (nick !== game.current) return;
    if (game.phase === "choose" && (t === "verdad" || t === "reto")) return vorPick(t);
    if (game.phase === "doing" && /^(listo|ya|hecho|termine|cumpli)$/.test(t)) return vorDone(nick);
    if (["doing", "choose", "asking", "asking-open"].includes(game.phase) && /^(paso|me planto)$/.test(t)) return vorPass(nick);
  }

  // ================== Duelos 1 contra 1 ==================
  const duels = new Map(); // id -> { id, a, b, kind, state, wins: {}, picks: {}, round, timer }
  const inDuel = (nick) => [...duels.values()].some((d) => d.state === "on" && (d.a === nick || d.b === nick));
  const PPT_EMO = { piedra: "🪨", papel: "📄", tijera: "✂️" };
  function duelExpire(d, msg) {
    clearTimeout(d.timer); duels.delete(d.id);
    [d.a, d.b].forEach((n) => { const t = byNick(n); if (t) { io.to(t.id).emit("duel-close", d.id); if (msg) notice(t.id, msg); } });
  }
  function pptAsk(d) {
    d.picks = {}; d.round++;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      const faltan = [d.a, d.b].filter((n) => !d.picks[n]);
      if (d.tour) { // en el torneo nadie queda trabado: pierde el que no eligió
        const picked = [d.a, d.b].filter((n) => d.picks[n]);
        const w = picked.length === 1 ? picked[0] : pick([d.a, d.b]);
        gameSay(`⏰ ${faltan.join(" y ")} no eligió a tiempo.${picked.length === 1 ? "" : " Se define por sorteo 🎲"}`);
        return finishDuel(d, w, w === d.a ? d.b : d.a);
      }
      gameSay(`⚔️ Duelo ${d.a} vs ${d.b} cancelado: ${faltan.join(" y ")} no eligió a tiempo.`);
      duelExpire(d);
    }, 45000);
    [[d.a, d.b], [d.b, d.a]].forEach(([me, opp]) => { const t = byNick(me); if (t) io.to(t.id).emit("duel-ppt", { id: d.id, opp, round: d.round, me: d.wins[me] || 0, them: d.wins[opp] || 0, tour: d.tour ? d.tourLabel : "" }); });
  }
  function finishDuel(d, winner, loser) {
    clearTimeout(d.timer); duels.delete(d.id);
    bumpNick(winner, "duels", 1, { xp: 8, capKey: "game", cap: 200 });
    if (d.tour) {
      addPoints(winner, 2);
      const isFinal = game?.type === "llaves" && game.rounds[game.rounds.length - 1]?.length === 1;
      gameSay(`🏟️ ${winner} le ganó a ${loser} (${d.wins[winner] || 0}-${d.wins[loser] || 0})${isFinal ? " ¡y gana la FINAL!" : " y avanza."} +2 pts`);
      [[d.a, d.b], [d.b, d.a]].forEach(([me, opp]) => { const t = byNick(me); if (t) io.to(t.id).emit("duel-end", { id: d.id, opp, kind: d.kind, won: me === winner, tour: true }); });
      return bracketResult(d.match, winner);
    }
    addPoints(winner, 3);
    gameSay(`🏆 ¡${winner} ganó el duelo de ${d.kind === "ppt" ? "piedra, papel o tijera" : "trivia"} contra ${loser}! +3 pts`);
    [[d.a, d.b], [d.b, d.a]].forEach(([me, opp]) => { const t = byNick(me); if (t) io.to(t.id).emit("duel-end", { id: d.id, opp, kind: d.kind, won: me === winner }); });
  }
  function endDuelTrivia(id, a, b) {
    const d = duels.get(id); if (!d) return;
    const sa = d.scores?.[a] || 0, sb = d.scores?.[b] || 0;
    if (sa === sb) {
      gameSay(`⚔️ Duelo de trivia ${a} vs ${b}: ¡empate ${sa} a ${sb}! 🤝`);
      duels.delete(id);
      [[a, b], [b, a]].forEach(([me, opp]) => { const t = byNick(me); if (t) io.to(t.id).emit("duel-end", { id, opp, kind: "trivia", won: null }); });
    } else finishDuel(d, sa > sb ? a : b, sa > sb ? b : a);
  }

  // ================== Torneo eliminatorio (llaves) ==================
  const roundName = (n) => n === 2 ? "FINAL" : n === 4 ? "SEMIFINALES" : n === 8 ? "CUARTOS DE FINAL" : n === 16 ? "OCTAVOS DE FINAL" : `RONDA DE ${n}`;
  function startBracket(starter, opts = {}) {
    const insc = Math.min(180, Math.max(20, parseInt(opts.secs) || 60)), bestOf = [1, 3, 5].includes(+opts.bestOf) ? +opts.bestOf : 3;
    game = { type: "llaves", phase: "inscripcion", starter, players: new Set([starter]), rounds: [], timers: [], need: Math.ceil(bestOf / 2), bestOf,
      cleanup() { this.timers.forEach(clearTimeout); for (const d of [...duels.values()]) if (d.tour) duelExpire(d, "🏟️ Se canceló el torneo."); } };
    gameSay(`🏟️ TORNEO ELIMINATORIO de piedra, papel o tijera — lo arrancó ${starter}.\n✋ Escriban "yo" para anotarse (${insc} s). Mínimo 3, máximo 16.\nCada cruce es ${bestOf === 1 ? "a una sola mano" : `al mejor de ${bestOf}`}. El campeón se lleva +10 pts y la gloria 🏆`);
    game.timers.push(setTimeout(() => {
      if (!game || game.type !== "llaves") return;
      const players = [...game.players].filter((n) => byNick(n));
      if (players.length < 3) { gameSay("🏟️ No se anotaron suficientes (mínimo 3). Torneo cancelado."); return endGame(); }
      for (let i = players.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [players[i], players[j]] = [players[j], players[i]]; }
      let size = 2; while (size < players.length) size *= 2;
      const slots = [...players, ...Array(size - players.length).fill(null)];
      // repartir los "pases libres" para que no se enfrenten dos vacíos
      const first = [];
      for (let i = 0; i < size / 2; i++) first.push({ a: slots[i], b: slots[size - 1 - i], winner: null });
      game.rounds = [first]; game.phase = "jugando";
      playBracketRound();
    }, insc * 1000));
  }
  function bracketText() {
    if (!game || game.type !== "llaves" || !game.rounds.length) return "🏟️ No hay torneo eliminatorio en curso.";
    return "🏟️ LLAVES\n" + game.rounds.map((r) => `— ${roundName(r.length * 2)} —\n` + r.map((m) => {
      const fmt = (n) => !n ? "(libre)" : m.winner === n ? `✅ ${n}` : m.winner ? `❌ ${n}` : n;
      return `${fmt(m.a)}  vs  ${fmt(m.b)}`;
    }).join("\n")).join("\n");
  }
  function playBracketRound() {
    if (!game || game.type !== "llaves") return;
    const round = game.rounds[game.rounds.length - 1];
    const label = roundName(round.length * 2);
    for (const m of round) {
      if (!m.b || !byNick(m.b)) { if (!m.winner && m.a) m.winner = m.a; }
      else if (!m.a || !byNick(m.a)) { if (!m.winner) m.winner = m.b; }
    }
    gameSay(`🏟️ ${label}\n` + round.map((m) => m.a && m.b ? `⚔️ ${m.a} vs ${m.b}` : `🎟️ ${m.a || m.b} pasa directo`).join("\n") + "\nA los que juegan les aparecen los botones. ¡Suerte!");
    for (const m of round) {
      if (m.winner) continue;
      const d = { id: newId(), a: m.a, b: m.b, kind: "ppt", state: "on", wins: {}, picks: {}, round: 0, tour: true, tourLabel: label, match: m, need: game.need };
      duels.set(d.id, d);
      pptAsk(d);
    }
    checkBracketRound();
  }
  function bracketResult(match, winner) { match.winner = winner; checkBracketRound(); }
  function checkBracketRound() {
    if (!game || game.type !== "llaves") return;
    const round = game.rounds[game.rounds.length - 1];
    if (round.some((m) => !m.winner)) return;
    const winners = round.map((m) => m.winner);
    if (winners.length === 1) {
      const champ = winners[0];
      addPoints(champ, 10);
      bumpNick(champ, "champ", 1, { xp: 60 });
      io.emit("announce", { text: `🏆 ¡${champ} es el/la CAMPEÓN/A del torneo eliminatorio! +10 pts`, ts: now() });
      gameSay(bracketText() + `\n\n🏆 CAMPEÓN/A: ${champ} 🎉`);
      return endGame();
    }
    const next = [];
    for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i], b: winners[i + 1], winner: null });
    game.rounds.push(next);
    game.timers.push(setTimeout(playBracketRound, 4000));
  }

  // ================== 100 rotos dicen ==================
  // La encuesta es el propio grupo: todos responden en secreto y suman los que coinciden con la mayoría.
  const ROTOS_Q = [
    "Algo que no puede faltar en un asado", "Una comida de domingo", "Un sabor de helado", "Una golosina de kiosco", "Un relleno de empanada",
    "Algo que hay en toda heladera", "Algo que se compra en el chino", "Algo que se toma en el desayuno", "Una excusa para llegar tarde",
    "Una excusa para no ir a una juntada", "Algo que se pierde siempre", "Algo que se lleva a la playa", "Algo que hacés cuando no podés dormir",
    "Algo que hacés cuando estás triste", "Algo que te pone de buen humor", "Una palabra para decir que algo está buenísimo", "Una frase típica de tu vieja",
    "Un apodo típico argentino", "Una banda de rock nacional", "Un jugador de fútbol argentino", "Una provincia para ir de vacaciones",
    "Una app que usás todos los días", "Una serie que vio todo el mundo", "Un superhéroe", "Un animal que te gustaría tener de mascota",
    "Un lugar para una primera cita", "Un regalo de último momento", "Una materia que odiabas en la escuela", "Algo que hay en una mochila",
    "Un deporte para ver por tele", "Un personaje de Los Simpson", "Algo que se hace en Navidad", "Algo que te da miedo de noche",
    "Una cosa que se rompe siempre en casa", "Un color de auto", "Algo que se hace en un colectivo", "Una bebida para una juntada",
    "Algo que se dice cuando te pegás en el dedo chiquito", "Un trabajo que te gustaría probar un día", "Algo que hacés apenas te levantás",
  ];
  const STOP = new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "mi", "tu", "con"]);
  const rotosKey = (t) => plain(t).split(" ").filter((w) => w && !STOP.has(w)).map((w) => w.length > 4 ? w.replace(/(es|s)$/, "") : w).join(" ");
  function startRotos(starter, rounds, customQs, secs) {
    const pool = customQs?.length ? customQs : [...ROTOS_Q].sort(() => Math.random() - 0.5).slice(0, rounds);
    rounds = pool.length;
    game = { type: "rotos", phase: "", qs: pool, round: 0, total: rounds, secs: secs || 40, scores: new Map(), answers: new Map(), timers: [], cleanup() { this.timers.forEach(clearTimeout); } };
    gameSay(`📊 100 ROTOS DICEN — ${rounds} pregunta${rounds === 1 ? "" : "s"}${customQs?.length ? ` de ${starter}` : ""}.\nEl bot pregunta y cada uno responde EN SECRETO escribiendo en el chat (nadie ve tu respuesta hasta el final).\nSumás si pensás igual que la mayoría: 🥇 +3 · 🥈 +2 · 🥉 +1`);
    game.timers.push(setTimeout(rotosNext, 4000));
  }
  function rotosNext() {
    if (!game || game.type !== "rotos") return;
    game.timers.forEach(clearTimeout); game.timers = [];
    if (game.round >= game.total) {
      const res = [...game.scores].sort((a, b) => b[1] - a[1]);
      gameSay(res.length ? `🏁 Fin de 100 rotos dicen. Ganó ${res[0][0]} con ${res[0][1]} pts — ¡la persona más "promedio" del chat! 😂\n` + res.map(([n, p]) => `${n}: ${p}`).join(" · ") : "🏁 Fin de 100 rotos dicen. ¡Nadie sumó!");
      return endGame();
    }
    game.round++; game.answers = new Map(); game.phase = "answering";
    game.q = game.qs[game.round - 1];
    game.endsAt = now() + game.secs * 1000;
    io.emit("rotos-q", { q: game.q, round: game.round, total: game.total, endsAt: game.endsAt });
    gameSay(`📊 Pregunta ${game.round}/${game.total}: «${game.q}»\n🤫 Escribí tu respuesta en el chat (${game.secs} s). Es secreta: nadie la ve hasta que revelemos.`);
    game.timers.push(setTimeout(rotosReveal, game.secs * 1000));
  }
  function rotosReveal() {
    if (!game || game.type !== "rotos" || game.phase !== "answering") return;
    game.phase = "reveal";
    io.emit("rotos-q", null);
    const groups = []; // { key, labels: Map(texto -> veces), people: [] }
    for (const [nick, ans] of game.answers) {
      const k = rotosKey(ans); if (!k) continue;
      let g = groups.find((x) => x.key === k || (k.length >= 5 && lev(x.key, k) <= 1));
      if (!g) groups.push(g = { key: k, labels: new Map(), people: [] });
      g.labels.set(ans.trim(), (g.labels.get(ans.trim()) || 0) + 1); g.people.push(nick);
    }
    if (game.answers.size < 2) { gameSay(`📊 «${game.q}»: llegaron ${game.answers.size} respuesta${game.answers.size === 1 ? "" : "s"}. ¡Se necesitan al menos 2! Seguimos…`); return game.timers.push(setTimeout(rotosNext, 5000)); }
    groups.sort((a, b) => b.people.length - a.people.length);
    const total = game.answers.size;
    const medals = ["🥇", "🥈", "🥉"], pts = [3, 2, 1];
    // los puestos se cuentan por cantidad de gente (empates comparten puesto)
    let place = 0, prev = -1;
    const lines = groups.slice(0, 6).map((g, i) => {
      if (g.people.length !== prev) { place = i; prev = g.people.length; }
      const label = [...g.labels].sort((a, b) => b[1] - a[1])[0][0];
      if (place < 3 && g.people.length >= 2) for (const n of g.people) { addPoints(n, pts[place]); bumpNick(n, "rotos", 1, { xp: 2, capKey: "game", cap: 200 }); game.scores.set(n, (game.scores.get(n) || 0) + pts[place]); }
      return `${place < 3 && g.people.length >= 2 ? medals[place] : "▫️"} ${label.toUpperCase()} — ${g.people.length} voto${g.people.length === 1 ? "" : "s"}\n      (${g.people.join(", ")})`;
    });
    const solos = groups.filter((g) => g.people.length === 1).length;
    gameSay(`📊 «${game.q}» — ${total} rotos dijeron:\n${lines.join("\n")}${solos ? `\n(${solos} respuesta${solos === 1 ? "" : "s"} única${solos === 1 ? "" : "s"}: originales, pero no suman 😅)` : ""}`);
    game.timers.push(setTimeout(rotosNext, 7000));
  }
  // Durante la pregunta, lo que escribís en Juegos es tu respuesta secreta (no se publica)
  function rotosIntercept(c, sid, text) {
    if (!game || game.type !== "rotos" || game.phase !== "answering") return false;
    const ans = text.trim().slice(0, 40);
    if (!rotosKey(ans)) return false;
    const had = game.answers.has(c.nick);
    game.answers.set(c.nick, ans);
    notice(sid, `🤫 ${had ? "Cambiaste tu respuesta" : "Respuesta guardada"}: «${ans}». Podés cambiarla hasta que termine el tiempo.`, "help");
    if (!had) io.emit("rotos-count", game.answers.size);
    return true;
  }

  // ================== Juicio popular ==================
  const CONDENAS = [
    "mandar un audio cantando el feliz cumpleaños 🎤", "usar solo emojis en sus próximos 5 mensajes", "decir algo lindo de cada miembro del jurado",
    "contar el chiste más malo que sepa", "cambiar su estado a 🌙 Ausente por 10 minutos (aunque esté presente)", "dibujar a la persona que lo acusó en 🖍️ Pizarra",
    "escribir un poema de disculpas de 4 versos", "mandar un audio imitando a un/a relator/a de fútbol", "elegir una canción y dedicársela al grupo",
    "escribir sus próximos 3 mensajes en MAYÚSCULAS DE FURIA", "contar una anécdota vergonzosa (suave)", "decir 3 cosas que le gustan de la persona que lo acusó",
  ];
  const ABSOLUCIONES = ["queda libre y con el honor intacto 🕊️", "sale absuelto/a entre aplausos 👏", "es declarado/a inocente: el que acusó paga los facturas 🥐"];
  function startJuicio(c, sid, targetNick, cargo, condena) {
    const t = byNick(targetNick);
    if (!t || t.id === sid) return notice(sid, "Elegí a alguien conectado (que no seas vos).");
    if (blockedPair(c, t.c)) return notice(sid, "No podés enjuiciar a esa persona.");
    cargo = censor(String(cargo || "").trim().slice(0, 120)).text;
    if (cargo.length < 4) return notice(sid, "Escribí de qué lo/la acusás. Ej: /juicio Pedro no saludó al entrar");
    condena = censor(String(condena || "").trim().slice(0, 120)).text;
    game = { type: "juicio", phase: "consent", fiscal: c.nick, acusado: t.c.nick, cargo, condena, timers: [], cleanup() { this.timers.forEach(clearTimeout); if (this.pollId) { const p = polls.get(this.pollId); if (p) { clearTimeout(p.timer); polls.delete(this.pollId); } } } };
    io.to(t.id).emit("juicio-request", { fiscal: c.nick, cargo });
    gameSay(`⚖️ ${c.nick} quiere llevar a juicio a ${t.c.nick} por: «${cargo}».\nEsperando que ${t.c.nick} acepte (30 s)…`);
    game.timers.push(setTimeout(() => { if (game?.type === "juicio" && game.phase === "consent") { gameSay(`⚖️ ${game.acusado} no respondió. Juicio suspendido.`); endGame(); } }, 30000));
  }
  function juicioAnswer(c, accept) {
    if (!game || game.type !== "juicio" || game.phase !== "consent" || c.nick !== game.acusado) return;
    game.timers.forEach(clearTimeout); game.timers = [];
    if (!accept) { gameSay(`⚖️ ${game.acusado} rechazó el juicio. ¡Se respeta! 🙌`); return endGame(); }
    game.phase = "defensa";
    gameSay(`🔨 ¡Comienza el juicio!\nAcusado/a: ${game.acusado} · Fiscal: ${game.fiscal}\nCargo: «${game.cargo}»\n🗣️ ${game.acusado}, tenés 60 s para defenderte en el chat. El fiscal y los testigos también pueden hablar.`);
    game.timers.push(setTimeout(juicioVoto, 60000));
  }
  function juicioVoto() {
    if (!game || game.type !== "juicio" || game.phase !== "defensa") return;
    game.phase = "voto";
    const id = newId(), endsAt = now() + 45000, options = ["🔨 Culpable", "🕊️ Inocente"];
    const g = game;
    const p = { room: ROOM, author: CRUPIER, question: `¿${g.acusado} es culpable de «${g.cargo}»?`, options, votes: new Map(), endsAt, exclude: [g.acusado],
      onEnd(counts, total) {
        if (game !== g) return;
        if (!total) { gameSay("⚖️ El jurado no votó. Caso archivado 🗄️"); return endGame(); }
        if (counts[0] > counts[1]) gameSay(`🔨 VEREDICTO: ¡CULPABLE! (${counts[0]} a ${counts[1]})\n📜 Condena: ${g.acusado} deberá ${g.condena || pick(CONDENAS)}.`);
        else if (counts[1] > counts[0]) gameSay(`🕊️ VEREDICTO: ¡INOCENTE! (${counts[1]} a ${counts[0]})\n${g.acusado} ${pick(ABSOLUCIONES)}`);
        else gameSay(`⚖️ VEREDICTO: ¡EMPATE! (${counts[0]} a ${counts[1]}). El tribunal declara el caso… un misterio 🤷`);
        endGame();
      } };
    p.timer = setTimeout(() => endPoll(id), 45000);
    polls.set(id, p); g.pollId = id;
    remember(id, { chat: ROOM, from: CRUPIER, text: "⚖️ " + p.question, ts: now(), media: true });
    io.emit("public-message", { id, room: ROOM, from: CRUPIER, bot: true, text: p.question, poll: { options, counts: [0, 0], endsAt }, ts: now() });
    gameSay(`🧑‍⚖️ ¡A votar, jurado! Tienen 45 s. (${g.acusado} no vota)`);
  }

  // ================== Herramientas comunes para juegos con inscripción ==================
  const ALIASES = ["🦊 Zorro", "🐙 Pulpo", "🦉 Búho", "🐢 Tortuga", "🦩 Flamenco", "🐝 Abeja", "🦔 Erizo", "🐧 Pingüino", "🦎 Lagartija", "🐳 Ballena", "🦜 Loro", "🐌 Caracol", "🦇 Murciélago", "🐞 Vaquita", "🦙 Llama", "🐿️ Ardilla"];
  const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function inscription(type, starter, title, rules, secs, min, max, onStart) {
    game = { type, phase: "inscripcion", starter, players: new Set([starter]), max, timers: [], cleanup() { this.timers.forEach(clearTimeout); this.onCleanup?.(); } };
    gameSay(`${title}\n${rules}\n✋ Escriban "yo" para jugar (${secs} s). Mínimo ${min}${max ? `, máximo ${max}` : ""}.`);
    game.timers.push(setTimeout(() => {
      if (!game || game.type !== type) return;
      const players = [...game.players].filter((n) => byNick(n));
      if (players.length < min) { gameSay(`Se necesitan al menos ${min} jugadores. Juego cancelado.`); return endGame(); }
      game.phase = "jugando"; game.players = new Set(players);
      onStart(players);
    }, secs * 1000));
  }
  function inscriptionGuess(nick, t) {
    if (game.phase !== "inscripcion" || !/^(yo|yo juego|me sumo|me anoto)$/.test(t) || game.players.has(nick)) return;
    if (game.max && game.players.size >= game.max) return gameSay("¡Cupo lleno!");
    game.players.add(nick); gameSay(`✍️ ${nick} se sumó (${game.players.size}).`);
  }
  const secretCard = (nick, title, text) => { const t = byNick(nick); if (t) io.to(t.id).emit("secret-card", { title, text, room: ROOM }); };
  // Votación con botones en Juegos (reutiliza las votaciones); al terminar llama a onEnd(counts, votes)
  function gamePoll(question, options, secs, onEnd, exclude = []) {
    const id = newId(), endsAt = now() + secs * 1000, g = game;
    const p = { room: ROOM, author: CRUPIER, question, options, votes: new Map(), endsAt, exclude,
      onEnd(counts) { if (game === g) onEnd(counts, p.votes); } };
    p.timer = setTimeout(() => endPoll(id), secs * 1000);
    polls.set(id, p); g.pollId = id;
    remember(id, { chat: ROOM, from: CRUPIER, text: "🗳️ " + question, ts: now(), media: true });
    io.emit("public-message", { id, room: ROOM, from: CRUPIER, bot: true, text: question, poll: { options, counts: options.map(() => 0), endsAt }, ts: now() });
    const old = g.cleanup; g.cleanup = function () { old.call(this); const pp = polls.get(id); if (pp) { clearTimeout(pp.timer); polls.delete(id); } };
  }
  const topVoted = (counts) => { const max = Math.max(...counts); return max ? counts.map((c, i) => c === max ? i : -1).filter((i) => i >= 0) : []; };

  // ================== 🤖 ¿Quién es la IA? ==================
  const TURING_TOPICS = ["¿Cuál es la peor comida que probaste?", "¿Qué harías con un millón de dólares?", "¿Playa o montaña y por qué?", "Contá algo que te dio vergüenza esta semana",
    "¿Cuál fue tu primer celular?", "¿Qué serie estás mirando?", "¿Mate dulce o amargo?", "¿Qué superpoder inútil te gustaría tener?", "¿Cuál es tu plan ideal de domingo?", "¿Le tenés miedo a algo raro?"];
  function startTuring(starter, mins = 3) {
    if (!AI_ON) return gameSay("🤖 Este juego necesita la IA activada (GROQ_API_KEY en Render).");
    inscription("turing", starter, "🤖 ¿QUIÉN ES LA IA?", "Todos reciben un apodo secreto de animal y la IA se mete como un jugador más. Charlen y descubran quién es la máquina.", 45, 3, 10, (players) => {
      const names = shuffle(ALIASES).slice(0, players.length + 1);
      game.alias = new Map(players.map((n, i) => [n, names[i]]));
      game.aiAlias = names[players.length];
      game.log = []; game.lastAi = 0; game.topic = pick(TURING_TOPICS); game.mins = mins;
      for (const [n, a] of game.alias) secretCard(n, "🎭 Tu apodo secreto", `Sos ${a}. Todo lo que escribas en Juegos sale con ese nombre.\nHay ${players.length + 1} participantes y UNO es la IA 🤖. ¡Que no te confundan con la máquina!`);
      gameSay(`🤖 ¡Arranca! Hay ${players.length + 1} participantes con apodo… y uno es la IA.\nTema para romper el hielo: «${game.topic}»\n💬 Charlen ${mins} minutos. Escriban normal: el bot lo publica con su apodo.`);
      game.timers.push(setTimeout(() => turingAiTalk(true), 7000));
      game.timers.push(setTimeout(() => { if (game?.type === "turing") gameSay("⏳ ¡Queda 1 minuto! Hagan preguntas tramposas 🕵️"); }, (mins - 1) * 60000));
      game.timers.push(setTimeout(turingVote, mins * 60000));
    });
  }
  function turingPublish(alias, text, mineSid) {
    const id = newId();
    remember(id, { chat: ROOM, from: alias, text, ts: now() });
    for (const [sid, rc] of clients) if (rc.nick) io.to(sid).emit("public-message", { id, room: ROOM, from: alias, alias: true, text, ts: now(), ...(sid === mineSid ? { mine: true } : {}) });
    game.log.push(`${alias}: ${text}`); if (game.log.length > 25) game.log.shift();
  }
  async function turingAiTalk(opening) {
    const g = game; if (!g || g.type !== "turing" || g.phase !== "jugando" || g.aiBusy) return;
    if (!opening && now() - g.lastAi < 12000) return;
    g.aiBusy = true;
    const prompt = `Estás jugando un juego de chat argentino llamado "¿Quién es la IA?". Sos un participante más con el apodo "${g.aiAlias}". Los demás son humanos y tienen que adivinar quién es la IA. TU OBJETIVO: que crean que sos humano.
  Reglas de estilo: escribí como un/a argentino/a de 20-35 años chateando desde el celu: mensajes MUY cortos (3 a 15 palabras), casi todo en minúscula, a veces sin tildes, algún error de tipeo ocasional, voseo, expresiones como "jaja", "nada", "re", "posta", "ni idea". Nada de signos de apertura ¿ ¡. Nunca digas que sos una IA, ni hables de forma formal o perfecta. Podés hacer preguntas, opinar, bromear o sospechar de otro apodo. No uses comillas.
  Tema inicial: ${g.topic}
  Charla hasta ahora:
  ${g.log.slice(-15).join("\n") || "(todavía nadie habló)"}
  Respondé SOLO con tu próximo mensaje (sin tu apodo adelante).`;
    const msg = await aiCall(prompt, false, 1.1);
    g.aiBusy = false;
    if (!msg || game !== g || g.phase !== "jugando") return;
    const clean = msg.replace(/^["'«]|["'»]$/g, "").replace(new RegExp("^" + g.aiAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":?\\s*"), "").split("\n")[0].slice(0, 160);
    // demora "humana" según el largo
    setTimeout(() => { if (game === g && g.phase === "jugando") { g.lastAi = now(); turingPublish(g.aiAlias, clean); } }, 1500 + clean.length * 90);
  }
  function turingIntercept(c, sid, text) {
    if (!game || game.type !== "turing" || game.phase !== "jugando") return false;
    if (!game.alias.has(c.nick)) { notice(sid, "🤖 Hay una ronda de ¿Quién es la IA? en curso: mirá y esperá la próxima 😉", "help"); return true; }
    turingPublish(game.alias.get(c.nick), text, sid);
    if (Math.random() < 0.55) setTimeout(() => turingAiTalk(false), 2500 + Math.random() * 6000);
    return true;
  }
  function turingVote() {
    if (!game || game.type !== "turing") return;
    game.phase = "voto";
    const opts = shuffle([...game.alias.values(), game.aiAlias]);
    gameSay("🗳️ ¡Tiempo! ¿Quién es la IA? Voten (45 s).");
    gamePoll("¿Quién es la IA? 🤖", opts, 45, (counts, votes) => {
      const g = game, aiIdx = opts.indexOf(g.aiAlias), top = topVoted(counts);
      const reveal = [...g.alias].map(([n, a]) => `${a} era ${n}`).concat([`${g.aiAlias} era 🤖 LA IA`]).join("\n");
      let msg;
      if (top.length === 1 && top[0] === aiIdx) {
        for (const [n, idx] of votes) if (idx === aiIdx && g.alias.has(n)) { addPoints(n, 3); bumpNick(n, "detective", 1, { xp: 5, capKey: "game", cap: 200 }); }
        msg = `🎉 ¡LOS HUMANOS GANAN! Descubrieron a la IA: era ${g.aiAlias}.\n+3 pts para los que la votaron.`;
      } else if (!top.length) msg = "🤷 Nadie votó… ¡la IA gana por abandono! 🤖";
      else {
        const sus = top.map((i) => opts[i]).join(" y ");
        msg = `🤖 ¡GANA LA IA! Ustedes votaron a ${sus}… pero la IA era ${g.aiAlias} 😈`;
      }
      gameSay(`${msg}\n\n🎭 Revelación:\n${reveal}`);
      endGame();
    });
  }

  // ================== 🃏 El Mentiroso ==================
  const FIBS = [
    ["Los pulpos tienen ___ corazones.", "tres"], ["Un día en Venus dura más que un ___ en Venus.", "año"], ["La miel bien guardada puede durar ___ sin echarse a perder.", "miles de años"],
    ["Los flamencos son rosados por lo que ___.", "comen"], ["El animal nacional de Escocia es el ___.", "unicornio"], ["Los wombats hacen caca en forma de ___.", "cubo"],
    ["Las nutrias marinas duermen tomadas de las ___ para no separarse.", "manos"], ["En Suiza es ilegal tener un solo ___ porque se siente solo.", "cobayo"],
    ["Los koalas tienen huellas digitales muy parecidas a las de los ___.", "humanos"], ["Un rayo es más caliente que la superficie del ___.", "sol"],
    ["La Torre Eiffel puede medir unos centímetros más en ___.", "verano"], ["El corazón de una ballena azul es del tamaño de un ___.", "auto chico"],
    ["Las vacas pueden estresarse cuando las separan de su ___.", "mejor amiga"], ["Los caracoles pueden dormir hasta ___ seguidos.", "tres años"],
    ["El sonido que hace un pato es parecido en todos los idiomas, pero en danés se escribe ___.", "rap"],
  ];
  async function fibRound() {
    const g = game; if (!g || g.type !== "mentiroso") return;
    g.timers.forEach(clearTimeout); g.timers = [];
    if (g.round >= g.total) {
      const res = [...g.scores].sort((a, b) => b[1] - a[1]);
      gameSay(res.length ? `🏁 Fin de El Mentiroso. Ganó ${res[0][0]} con ${res[0][1]} punto${res[0][1] === 1 ? "" : "s"} 🃏\n` + res.map(([n, p]) => `${n}: ${p}`).join(" · ") : "🏁 Fin de El Mentiroso. ¡Nadie sumó!");
      return endGame();
    }
    g.round++; g.phase = "cargando"; g.lies = new Map();
    let fact = null;
    if (AI_ON) {
      const r = await aiCall(`Dame UN dato curioso REAL, verificable y sorprendente (animales, historia, cuerpo humano, países, inventos) escrito en español rioplatense, con UNA palabra o expresión clave reemplazada por "___". La respuesta oculta tiene que ser corta (1 a 3 palabras) y difícil de adivinar pero no imposible. No repitas: ${g.used.join(" | ")}. Devolvé SOLO JSON: {"dato":"... ___ ...","respuesta":"..."}`);
      if (r?.dato?.includes("___") && r.respuesta) fact = [String(r.dato).slice(0, 220), String(r.respuesta).slice(0, 40)];
    }
    if (game !== g) return;
    if (!fact) { const pool = FIBS.filter(([d]) => !g.used.includes(d)); fact = pick(pool.length ? pool : FIBS); }
    g.used.push(fact[0]); g.fact = fact; g.phase = "mentir";
    gameSay(`🃏 Ronda ${g.round}/${g.total}:\n«${fact[0]}»\n🤥 Escribí en el chat una respuesta FALSA pero creíble para completar el hueco (45 s). Es secreta. ¡Si otros la votan, sumás!`);
    io.emit("rotos-q", { q: "🃏 " + fact[0], round: g.round, total: g.total, endsAt: now() + 45000, hint: "🤥 Escribí tu mentira (secreta)" });
    g.timers.push(setTimeout(fibVote, 45000));
  }
  function fibIntercept(c, sid, text) {
    if (!game || game.type !== "mentiroso" || game.phase !== "mentir") return false;
    const lie = text.trim().slice(0, 40);
    const lt = plain(lie), truth = plain(game.fact[1]);
    if (!lt) return false;
    if (lt === truth || (truth.length >= 4 && lev(lt, truth) <= 1)) { notice(sid, "😮 ¡Esa es la VERDAD! Inventá otra cosa (y guardate el secreto 🤫).", "help"); return true; }
    const had = game.lies.has(c.nick);
    game.lies.set(c.nick, lie);
    notice(sid, `🤥 ${had ? "Cambiaste tu mentira" : "Mentira guardada"}: «${lie}»`, "help");
    io.emit("rotos-count", game.lies.size);
    return true;
  }
  function fibVote() {
    const g = game; if (!g || g.type !== "mentiroso" || g.phase !== "mentir") return;
    io.emit("rotos-q", null);
    g.phase = "votar";
    if (!g.lies.size) { gameSay(`😴 Nadie mintió. La respuesta era: ${g.fact[1].toUpperCase()}`); return g.timers.push(setTimeout(fibRound, 4000)); }
    // juntar mentiras iguales
    const byText = new Map();
    for (const [n, l] of g.lies) { const k = plain(l); if (!byText.has(k)) byText.set(k, { text: l, authors: [] }); byText.get(k).authors.push(n); }
    const opts = shuffle([{ text: g.fact[1], truth: true, authors: [] }, ...byText.values()]);
    g.opts = opts;
    gamePoll(`¿Cuál es la VERDAD? «${g.fact[0]}»`, opts.map((o) => o.text), 35, (counts, votes) => {
      const ti = opts.findIndex((o) => o.truth); const lines = [];
      for (const [voter, idx] of votes) {
        const o = opts[idx];
        if (o.truth) { addPoints(voter, 2); g.scores.set(voter, (g.scores.get(voter) || 0) + 2); }
        else for (const a of o.authors) if (a !== voter) { addPoints(a, 1); g.scores.set(a, (g.scores.get(a) || 0) + 1); bumpNick(a, "fooled", 1, { xp: 2, capKey: "game", cap: 200 }); }
      }
      opts.forEach((o, i) => { if (!o.truth) lines.push(`🤥 «${o.text}» — de ${o.authors.join(", ")}${counts[i] ? ` (engañó a ${counts[i]} 😈)` : ""}`); });
      gameSay(`✅ La verdad era: «${g.fact[0].replace("___", g.fact[1].toUpperCase())}»\n${counts[ti] ? `${counts[ti]} la encontraron (+2)` : "¡Nadie la encontró!"}\n${lines.join("\n")}`);
      g.phase = "pausa"; g.timers.push(setTimeout(fibRound, 6000));
    });
  }
  function startMentiroso(starter, rounds = 3) {
    game = { type: "mentiroso", phase: "", round: 0, total: rounds, scores: new Map(), used: [], timers: [], cleanup() { this.timers.forEach(clearTimeout); io.emit("rotos-q", null); } };
    gameSay(`🃏 EL MENTIROSO — ${rounds} rondas. Sale un dato real con un hueco: inventá una respuesta falsa pero creíble. Después todos votan cuál es la verdad.\n+2 si encontrás la verdad · +1 por cada persona que caiga en tu mentira.`);
    game.timers.push(setTimeout(fibRound, 4000));
  }

  // ================== 🫣 El Impostor ==================
  const IMP_PAIRS = [["playa", "pileta"], ["mate", "té"], ["perro", "gato"], ["pizza", "empanada"], ["fútbol", "básquet"], ["guitarra", "violín"], ["colectivo", "tren"],
    ["invierno", "otoño"], ["helado", "yogur"], ["cine", "teatro"], ["avión", "helicóptero"], ["río", "lago"], ["café", "chocolatada"], ["cumpleaños", "casamiento"],
    ["escuela", "universidad"], ["asado", "parrilla de verduras"], ["bicicleta", "moto"], ["luna", "sol"], ["zapatilla", "ojota"], ["supermercado", "kiosco"],
    ["dentista", "médico"], ["Navidad", "Año Nuevo"], ["montaña", "volcán"], ["piano", "teclado"], ["lluvia", "nieve"]];
  function startImpostor(starter, customPair) {
    inscription("impostor", starter, "🫣 EL IMPOSTOR", "Todos reciben la misma palabra secreta… menos uno, que recibe una parecida (¡y no sabe que es el impostor!). Den pistas y descubran quién es.", 40, 3, 10, async (players) => {
      const g = game;
      let pair = customPair;
      if (!pair && AI_ON) {
        const r = await aiCall(`Juego "El Impostor" para argentinos. Dame DOS palabras comunes y concretas que sean parecidas pero distintas (ej: "playa" y "pileta", "mate" y "té"), fáciles de describir con una pista. Variá los temas. Devolvé SOLO JSON: {"palabra":"...","parecida":"..."}`);
        if (r?.palabra && r?.parecida) pair = [String(r.palabra).slice(0, 30), String(r.parecida).slice(0, 30)];
      }
      if (game !== g) return;
      if (!pair) pair = pick(IMP_PAIRS);
      if (Math.random() < 0.5) pair = [pair[1], pair[0]];
      g.word = pair[0]; g.fake = pair[1]; g.impostor = pick(players); g.order = shuffle(players); g.turn = 0; g.clueRound = 1; g.clues = [];
      for (const n of players) secretCard(n, "🤫 Tu palabra secreta", `${(n === g.impostor ? g.fake : g.word).toUpperCase()}\n\nDá pistas de UNA palabra sin decirla. Si sospechás que tu palabra es distinta a la de los demás… ¡quizás seas el impostor! 🫣`);
      gameSay(`🫣 Ya todos tienen su palabra secreta (mirá tu tarjeta). Orden de pistas:\n${g.order.map((n, i) => `${i + 1}. ${n}`).join("\n")}\nSon 2 vueltas de pistas de UNA palabra.`);
      g.timers.push(setTimeout(impTurn, 3000));
    });
  }
  function impTurn() {
    const g = game; if (!g || g.type !== "impostor") return;
    g.timers.forEach(clearTimeout); g.timers = [];
    while (g.turn < g.order.length && !byNick(g.order[g.turn])) g.turn++;
    if (g.turn >= g.order.length) {
      if (g.clueRound < 2) { g.clueRound++; g.turn = 0; gameSay("🔁 Segunda vuelta de pistas."); return g.timers.push(setTimeout(impTurn, 2000)); }
      g.phase = "debate";
      gameSay(`🗣️ Pistas:\n${g.clues.join("\n")}\n\n💬 ¡Debatan 45 s! ¿Quién parece tener otra palabra?`);
      return g.timers.push(setTimeout(impVote, 45000));
    }
    g.phase = "pista"; g.current = g.order[g.turn];
    gameSay(`👉 Turno de ${g.current}: escribí tu pista de UNA palabra (30 s).`);
    g.timers.push(setTimeout(() => { if (game === g && g.phase === "pista") { g.clues.push(`${g.current}: (no dijo nada 🤐)`); g.turn++; impTurn(); } }, 30000));
  }
  function impIntercept(c, sid, text) {
    if (!game || game.type !== "impostor" || game.phase !== "pista" || c.nick !== game.current) return false;
    const clue = text.trim().split(/\s+/)[0].slice(0, 25), t = plain(clue);
    const mine = plain(c.nick === game.impostor ? game.fake : game.word);
    if (!t) return false;
    if (t === mine || mine.split(" ").includes(t)) { notice(sid, "🤫 ¡No podés decir tu palabra! Elegí otra pista.", "warn"); return true; }
    game.clues.push(`${c.nick}: ${clue}`);
    gameSay(`💡 ${c.nick}: «${clue}»`);
    game.turn++; game.phase = "espera";
    game.timers.forEach(clearTimeout); game.timers = [setTimeout(impTurn, 1200)];
    return true;
  }
  function impVote() {
    const g = game; if (!g || g.type !== "impostor") return;
    g.phase = "voto";
    const opts = g.order.filter((n) => byNick(n));
    gamePoll("¿Quién es el impostor? 🫣", opts, 40, (counts, votes) => {
      const top = topVoted(counts), caught = top.length === 1 && opts[top[0]] === g.impostor;
      if (caught) { for (const n of opts) if (n !== g.impostor) addPoints(n, 2); }
      else addPoints(g.impostor, 4);
      for (const [n, idx] of votes) if (n !== g.impostor && opts[idx] === g.impostor) bumpNick(n, "detective", 1, { xp: 5, capKey: "game", cap: 200 });
      if (!caught) bumpNick(g.impostor, "fooled", Math.max(1, [...votes.keys()].filter((n) => n !== g.impostor).length), { xp: 8, capKey: "game", cap: 200 });
      gameSay(`${caught ? `🎯 ¡LO ENCONTRARON! El impostor era ${g.impostor}. +2 para el resto.` : `😈 ¡GANA EL IMPOSTOR! Era ${g.impostor} y ${top.length ? `votaron a ${top.map((i) => opts[i]).join(" y ")}` : "nadie votó"}. +4 para ${g.impostor}.`}\n🔑 La palabra era ${g.word.toUpperCase()} y el impostor tenía ${g.fake.toUpperCase()}.`);
      endGame();
    });
  }

  // ================== 🔪 Asesinato en Gente Rota ==================
  function fallbackMystery(n, tema) {
    const roles = shuffle(["el/la cocinero/a", "el/la jardinero/a", "el/la sobrino/a heredero/a", "el/la mayordomo/a", "el/la vecino/a chusma", "el/la socio/a del negocio", "el/la ex pareja", "el/la detective retirado/a"]).slice(0, n);
    const culpable = Math.floor(Math.random() * n);
    return {
      titulo: "El último mate de Don Ernesto", escenario: `Una estancia en las afueras${tema ? ` (${tema})` : ""}. Tormenta, luz cortada, todos encerrados.`,
      victima: "Don Ernesto, el dueño de la estancia, apareció dormido para siempre al lado de su termo.",
      personajes: roles.map((r, i) => ({ rol: r, secreto: i === culpable ? "Cambiaste la yerba de Don Ernesto por una que te dio un curandero. No querías que muriera… solo que firmara el testamento." : pick(["Discutiste con Don Ernesto esa tarde por plata.", "Le escondías una carta de amor vieja.", "Le robabas facturas de la cocina hace meses.", "Querías comprarle la estancia barata.", "Viste a alguien entrar a la cocina a las 3 de la mañana, pero no sabés quién."]),
        pista: pick(["Escuchaste un ruido de termo a la madrugada.", "Viste barro en las zapatillas de alguien.", "Encontraste un paquete de yerba sin marca en la basura.", "Alguien preguntó por el testamento antes de la cena.", "La puerta de la cocina estaba abierta a las 3 am."]) })),
      culpable, arma: "una yerba adulterada", pista_publica: "En la cocina había un paquete de yerba sin marca y un testamento sin firmar.",
      final: "La yerba adulterada fue la trampa. El testamento nunca se firmó y Don Ernesto se llevó su secreto al más allá… con el mate todavía tibio.",
    };
  }
  function startAsesinato(starter, tema) {
    inscription("asesinato", starter, "🔪 ASESINATO EN GENTE ROTA", "A cada uno le llega por privado un personaje, un secreto y una pista. Uno es el asesino (y lo sabe). Interróguense y descubran quién fue.", 50, 3, 8, async (players) => {
      const g = game;
      gameSay("🕯️ Preparando el misterio…");
      let m = null;
      if (AI_ON) {
        m = await aiCall(`Creá un misterio de asesinato corto y divertido (tono de comedia, nada gore ni violento explícito) para jugar en un chat argentino con ${players.length} jugadores${tema ? `, ambientado en: ${tema}` : ""}. Cada jugador interpreta un personaje sospechoso. Uno es el culpable.
  Devolvé SOLO JSON: {"titulo":"...","escenario":"1-2 oraciones","victima":"quién murió y cómo lo encontraron, 1 oración, sin sangre","arma":"...","personajes":[{"rol":"nombre del personaje y oficio","secreto":"algo que oculta (si es el culpable: cómo lo hizo y por qué)","pista":"una pista útil sobre OTRO personaje o el crimen"}],"culpable":índice (0 a ${players.length - 1}) del personaje culpable,"pista_publica":"una pista que se revela a mitad del juego","final":"revelación final en 2-3 oraciones"}
  Tienen que ser exactamente ${players.length} personajes.`);
        if (!m || !Array.isArray(m.personajes) || m.personajes.length < players.length || !(m.culpable >= 0 && m.culpable < players.length)) m = null;
      }
      if (game !== g) return;
      if (!m) m = fallbackMystery(players.length, tema);
      g.m = m; g.roles = new Map(); g.culprit = players[m.culpable];
      players.forEach((n, i) => {
        const p = m.personajes[i]; g.roles.set(n, p.rol);
        secretCard(n, i === m.culpable ? "🔪 SOS EL ASESINO" : "🕵️ Tu personaje", `Sos ${p.rol}.\n🤐 Tu secreto: ${p.secreto}\n🔎 Tu pista: ${p.pista}\n\n${i === m.culpable ? "Mentí, desviá sospechas y que no te descubran 😈" : "Contá lo que te convenga, interrogá a los demás y descubrí al asesino."}`);
      });
      gameSay(`🔪 ${String(m.titulo).toUpperCase()}\n🏚️ ${m.escenario}\n💀 ${m.victima}\n\n🎭 Sospechosos:\n${players.map((n) => `• ${n} — ${g.roles.get(n)}`).join("\n")}\n\n💬 Tienen 4 minutos para interrogarse. Miren su tarjeta secreta 🤫`);
      g.timers.push(setTimeout(() => { if (game === g) gameSay(`🔎 NUEVA PISTA: ${m.pista_publica}\n⏳ Quedan 2 minutos.`); }, 120000));
      g.timers.push(setTimeout(() => { if (game === g) gameSay("⏳ ¡Último minuto! Prepárense para acusar."); }, 180000));
      g.timers.push(setTimeout(asesinatoVote, 240000));
    });
  }
  function asesinatoVote() {
    const g = game; if (!g || g.type !== "asesinato") return;
    g.phase = "voto";
    const opts = [...g.roles.keys()].filter((n) => byNick(n));
    gamePoll("🔪 ¿Quién es el asesino?", opts, 45, (counts, votes) => {
      const top = topVoted(counts), caught = top.length === 1 && opts[top[0]] === g.culprit;
      for (const [n, idx] of votes) if (opts[idx] === g.culprit && n !== g.culprit) { addPoints(n, 2); bumpNick(n, "detective", 1, { xp: 5, capKey: "game", cap: 200 }); }
      if (!caught) { addPoints(g.culprit, 5); bumpNick(g.culprit, "fooled", Math.max(1, [...votes.keys()].filter((n) => n !== g.culprit).length), { xp: 8, capKey: "game", cap: 200 }); }
      gameSay(`${caught ? `🚔 ¡ATRAPADO! El asesino era ${g.culprit} (${g.roles.get(g.culprit)}). +2 para quienes lo votaron.` : `😈 ¡EL ASESINO ESCAPÓ! Era ${g.culprit} (${g.roles.get(g.culprit)}). +5 para el/la asesino/a.`}\n🗝️ Arma: ${g.m.arma}\n📜 ${g.m.final}`);
      endGame();
    });
  }

  // ================== 🗣️ ¿Quién dijo esto? (frases célebres del chat) ==================
  function startQuienDijo(starter, rounds = 5) {
    const pool = frases.filter((f) => f.at < now() - 10 * 60000); // que no sea de recién
    if (pool.length < 3) return gameSay(`🗣️ Todavía no hay suficientes frases célebres (hay ${pool.length}, se necesitan 3).\nUn mensaje se vuelve frase célebre cuando 3 personas le reaccionan, cuando una publicación de 📰 Comunidad junta 3 ❤️, o cuando un moderador lo marca con ⭐.`);
    rounds = Math.min(rounds, pool.length, 15);
    game = { type: "quiendijo", left: rounds, total: rounds, scores: new Map(), used: new Set(), timers: [], cleanup() { this.timers.forEach(clearTimeout); } };
    gameSay(`🗣️ ¿QUIÉN DIJO ESTO? — ${rounds} frases célebres de Gente Rota.\nEscribí el apodo de quien lo dijo. El autor de la frase no puede contestar 😉`);
    game.timers.push(setTimeout(qdRound, 3000));
  }
  const agoTxt = (t) => { const d = Math.floor((now() - t) / 86400e3); return d <= 0 ? "hoy" : d === 1 ? "ayer" : d < 30 ? `hace ${d} días` : d < 365 ? `hace ${Math.floor(d / 30)} mes${d >= 60 ? "es" : ""}` : "hace más de un año"; };
  function qdRound() {
    const g = game; if (!g || g.type !== "quiendijo") return;
    g.timers.forEach(clearTimeout); g.timers = [];
    // las menos usadas primero (y entre esas, al azar)
    const pool = frases.filter((f) => !g.used.has(f.id) && f.at < now() - 10 * 60000).sort((a, b) => (a.uses || 0) - (b.uses || 0));
    const low = pool.filter((f) => (f.uses || 0) === (pool[0]?.uses || 0));
    const f = pick(low.length ? low : pool);
    if (!f) return qdEnd();
    g.used.add(f.id); f.uses = (f.uses || 0) + 1; f.lastUsed = now(); saveFrases();
    g.cur = f; g.hints = 0; g.n = (g.n || 0) + 1;
    const extra = f.kind === "muro" ? `📰 en Comunidad · ${agoTxt(f.at)}${f.score ? ` · ${f.score} ❤️` : ""}` : `${f.src} · ${agoTxt(f.at)}${f.score ? ` · ${f.score} personas reaccionaron` : ""}`;
    gameSay(`🗣️ [${g.n}/${g.total}] ¿Quién dijo esto?\n«${f.text}»\n(${extra}) — 30 s`);
    const name = f.by;
    g.timers.push(setTimeout(() => { if (game === g && g.cur === f) { g.hints = 1; gameSay(`💡 Empieza con «${name[0].toUpperCase()}» (ahora vale 2)`); } }, 11000));
    g.timers.push(setTimeout(() => { if (game === g && g.cur === f) { g.hints = 2; gameSay(`💡 ${[...name].map((ch, i) => (i === 0 || /\s/.test(ch) ? ch.toUpperCase() : i === name.length - 1 ? ch : "_")).join(" ")} (${name.length} letras, ahora vale 1)`); } }, 21000));
    g.timers.push(setTimeout(() => qdReveal(null), 30000));
  }
  function qdReveal(winner) {
    const g = game; if (!g || g.type !== "quiendijo" || !g.cur) return;
    const f = g.cur; g.cur = null;
    g.timers.forEach(clearTimeout); g.timers = [];
    if (winner) {
      const pts = Math.max(1, 3 - g.hints);
      addPoints(winner, pts); g.scores.set(winner, (g.scores.get(winner) || 0) + pts);
      bumpNick(winner, "guessed", 1, { xp: 4, capKey: "game", cap: 200 });
      gameSay(`✅ ¡${winner} acertó! Lo dijo ${f.by}. +${pts} pt${pts === 1 ? "" : "s"}`);
    } else gameSay(`⏰ Nadie acertó: lo dijo ${f.by} 👏`);
    // el autor se entera de que su frase salió
    const t = byNick(f.by); if (t && (!f.pkey || t.c.pkey === f.pkey)) { const p = profK(t.c.pkey, t.c.nick); if (p) gainPz(t.c.pkey, p, 2, "pFrase", 15, "tu frase salió en el juego"); }
    g.left--;
    if (g.left > 0) g.timers.push(setTimeout(qdRound, 4000)); else g.timers.push(setTimeout(qdEnd, 2500));
  }
  function qdEnd() {
    const g = game; if (!g || g.type !== "quiendijo") return;
    const res = [...g.scores].sort((a, b) => b[1] - a[1]);
    endGame();
    gameSay(res.length ? `🏁 Fin de ¿Quién dijo esto? Ganó ${res[0][0]} con ${res[0][1]} punto${res[0][1] === 1 ? "" : "s"} 🗣️\n` + res.map(([n, p]) => `${n}: ${p}`).join(" · ") : "🏁 Fin de ¿Quién dijo esto? Nadie acertó… ¡no se conocen nada! 😅");
  }
  function qdGuess(nick, t) {
    const g = game, f = g.cur; if (!f) return;
    const who = byNick(nick);
    if (nick === f.by || (f.pkey && who?.c?.pkey === f.pkey)) return; // el autor no juega esta
    const a = plain(f.by), x = plain(t).replace(/^@/, "");
    if (x === a || (a.length >= 5 && lev(x, a) <= 1) || x.split(" ").includes(a)) qdReveal(nick);
  }

  // Eventos del celu que son de esta sala de juegos
  function bind(socket, c) {
    // ---- Juegos personalizados ----
    socket.on("game-custom", (o = {}, cb) => {
      if (!CUSTOM_OF[KIND].includes(o.type)) return; // lo atiende la sala que corresponde
      const fail = (error) => cb && cb({ ok: false, error });
      if (!c.nick) return;
      if (c.mutedUntil > now() && !c.admin) return fail("Estás silenciado/a.");
      if (game) return fail(`Ya hay un juego en curso en ${ROOM_LABEL[KIND]}. Esperá a que termine (o /rendirse).`);
      const ub = juegosBanUntil(c); if (ub) return fail(`Estás penalizado/a en Juegos. Faltan ${minsLeft(ub)}.`);
      const txt = (x, max) => censor(String(x || "").trim().replace(/\s+/g, " ").slice(0, max)).text;
      const secs = (v, min, max, def) => Math.min(max, Math.max(min, parseInt(v) || def));
      switch (o.type) {
        case "rotos": {
          const qs = (Array.isArray(o.questions) ? o.questions : []).map((q) => txt(q, 120)).filter((q) => q.length >= 3).slice(0, 10);
          if (!qs.length) return fail("Escribí al menos una pregunta.");
          startRotos(c.nick, qs.length, qs, secs(o.secs, 15, 120, 40)); break;
        }
        case "trivia": {
          const qs = (Array.isArray(o.questions) ? o.questions : []).map((x) => ({ q: txt(x?.q, 200), a: String(x?.a || "").split(/\s*[\/|]\s*/).map((y) => txt(y, 60)).filter(Boolean) }))
            .filter((x) => x.q.length >= 3 && x.a.length).slice(0, 15);
          if (!qs.length) return fail("Cargá al menos una pregunta con su respuesta.");
          triviaRound = { left: qs.length, total: qs.length, temas: [], scores: new Map(), custom: qs, creator: c.nick, secs: secs(o.secs, 15, 120, 40), hints: o.hints !== false };
          gameSay(`❓ TRIVIA PERSONALIZADA de ${c.nick}: ${qs.length} pregunta${qs.length === 1 ? "" : "s"}. ¡Atentos!`);
          startTrivia(""); break;
        }
        case "dibujo": {
          const words = [...new Set((Array.isArray(o.words) ? o.words : []).map((w) => txt(w, 30).toLowerCase()).filter((w) => w.length >= 2))].slice(0, 50);
          const rounds = Math.min(10, Math.max(1, parseInt(o.rounds) || Math.min(5, words.length || 5)));
          startPictionary(c, rounds, words, secs(o.secs, 30, 180, 90)); break;
        }
        case "ahorcado": {
          const w = plain(o.word).replace(/[^a-zñ ]/g, "").replace(/\s+/g, " ").trim().slice(0, 30);
          if (w.replace(/ /g, "").length < 3) return fail("La palabra tiene que tener al menos 3 letras (sin números ni símbolos).");
          if (censor(w).harm) return fail("Elegí otra palabra.");
          const lives = Math.min(12, Math.max(3, parseInt(o.lives) || 6));
          game = { type: "ahorcado", word: w, found: new Set(), wrong: [], lives, excl: c.nick, timer: setTimeout(() => { const g = game; endGame(); gameSay(`⏰ Se terminó el tiempo. La palabra era ${g.word.toUpperCase()}`); }, 5 * 60000) };
          gameSay(`🪢 AHORCADO PERSONALIZADO de ${c.nick}\n${hangView()}\nEscribí una letra o arriesgá la palabra entera. Tienen ${lives} vidas. (${c.nick} no juega 😉)`); break;
        }
        case "eliminatorio": startBracket(c.nick, { secs: o.secs, bestOf: o.bestOf }); break;
        case "vor": {
          const type = VOR_PEN_TYPES.includes(o.pen) ? o.pen : "juegos";
          startVor(c.nick, { type, mins: secs(o.mins, 1, 60, 5), pts: secs(o.pts, 1, 20, 3), free: Math.min(5, Math.max(0, Number.isFinite(+o.free) && o.free !== "" ? +o.free : 1)), vote: o.vote !== false, doSecs: secs(o.doMins, 1, 10, 3) * 60 });
          break;
        }
        case "turing": if (!AI_ON) return fail("Este juego necesita la IA activada."); startTuring(c.nick, Math.min(6, Math.max(2, parseInt(o.mins) || 3))); break;
        case "mentiroso": startMentiroso(c.nick, Math.min(8, Math.max(1, parseInt(o.rounds) || 3))); break;
        case "impostor": {
          const a = txt(o.word, 30), b = txt(o.fake, 30);
          if ((a || b) && (!a || !b || plain(a) === plain(b))) return fail("Poné las dos palabras (distintas) o dejalas vacías.");
          startImpostor(c.nick, a && b ? [a, b] : null); break;
        }
        case "asesinato": startAsesinato(c.nick, txt(o.tema, 60)); break;
      }
      cb && cb({ ok: true });
    });
    if (KIND === "fiesta") {
      // ---- Juicio: el acusado acepta o rechaza ----
      socket.on("juicio-answer", (accept) => juicioAnswer(c, !!accept));
      socket.on("juicio-start", ({ to, cargo, condena } = {}) => {
        if (!c.nick) return;
        if (game) return notice(socket.id, `Ya hay un juego en curso en ${ROOM_LABEL[KIND]}. Esperá a que termine.`);
        startJuicio(c, socket.id, to, cargo, condena);
      });
      // ---- Verdad o reto: el que tiene el turno elige con botones ----
      socket.on("vor-pick", (kind) => { if (game?.type === "vor" && game.current === c.nick && game.phase === "choose" && ["verdad", "reto"].includes(kind)) vorPick(kind); });
      // ---- Dibujá y adiviná ----
      socket.on("pic-get", () => { socket.emit("pic-state", picState()); if (game?.type === "dibujo") { socket.emit("pic-board", game.pieces); if (game.drawer === c.nick && game.word) socket.emit("pic-word", game.word); } });
      let picTimes = [];
      socket.on("pic-draw", (pc = {}) => {
        if (!game || game.type !== "dibujo" || game.drawer !== c.nick) return;
        const t = now(); picTimes = picTimes.filter((x) => t - x < 1000); if (picTimes.length > 40) return; picTimes.push(t);
        const p = Array.isArray(pc.p) ? pc.p.slice(0, 400).map((v, i) => Math.max(0, Math.min(i % 2 ? 600 : 800, Math.round(+v || 0)))) : [];
        if (p.length < 2 || !COLOR_RE.test(pc.c || "")) return;
        const piece = { c: pc.c, w: Math.min(50, Math.max(1, +pc.w || 5)), p };
        game.pieces.push(piece); if (game.pieces.length > 4000) game.pieces.shift();
        socket.broadcast.emit("pic-draw", piece);
      });
      socket.on("pic-clear", () => { if (game?.type === "dibujo" && game.drawer === c.nick) { game.pieces = []; io.emit("pic-board", []); } });
      socket.on("pic-skip", () => { if (game?.type === "dibujo" && game.drawer === c.nick) { gameSay(`⏭️ ${c.nick} pasó la palabra.`); endPicRound(null); } });
    }
    if (KIND === "duelos") {
      // ---- Duelos ----
      socket.on("duel-invite", ({ to, kind } = {}) => {
        if (!c.nick) return;
        kind = kind === "trivia" ? "trivia" : "ppt";
        const t = byNick(to);
        if (!t || t.id === socket.id) return notice(socket.id, "No encuentro a esa persona.");
        if (blockedPair(c, t.c)) return notice(socket.id, "No podés desafiar a esa persona.");
        if (inDuel(c.nick) || inDuel(t.c.nick)) return notice(socket.id, "Alguno de los dos ya está en un duelo.");
        if ([...duels.values()].filter((d) => d.a === c.nick && d.state === "invite").length >= 2) return notice(socket.id, "Ya tenés desafíos esperando respuesta.");
        const d = { id: newId(), a: c.nick, b: t.c.nick, kind, state: "invite", wins: {}, picks: {}, round: 0, scores: {} };
        d.timer = setTimeout(() => duelExpire(d, `⌛ El desafío entre ${d.a} y ${d.b} venció.`), 60000);
        duels.set(d.id, d);
        io.to(t.id).emit("duel-invite", { id: d.id, from: c.nick, kind });
        notice(socket.id, `⚔️ Desafiaste a ${t.c.nick} a ${kind === "ppt" ? "piedra, papel o tijera (al mejor de 3)" : "un duelo de trivia (5 preguntas)"}. Esperando respuesta…`);
      });
      socket.on("duel-answer", ({ id, accept } = {}) => {
        const d = duels.get(id); if (!d || d.b !== c.nick || d.state !== "invite") return;
        if (!accept) return duelExpire(d, `🙅 ${d.b} rechazó el duelo.`);
        clearTimeout(d.timer);
        if (inDuel(d.a) || inDuel(d.b)) return duelExpire(d, "Alguno de los dos ya está en otro duelo.");
        if (d.kind === "trivia") {
          if (game) return duelExpire(d, `Hay otro juego en curso en ${ROOM_LABEL[KIND]}. Prueben cuando termine.`);
          d.state = "on";
          gameSay(`⚔️ ¡DUELO DE TRIVIA! ${d.a} vs ${d.b} — 5 preguntas, solo responden ellos dos. ¡Vengan a mirar!`);
          triviaRound = { left: 5, total: 5, temas: [], scores: new Map(), duel: { id: d.id, a: d.a, b: d.b, scores: d.scores } };
          [d.a, d.b].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("duel-go", { id: d.id, room: ROOM }); });
          return startTrivia("");
        }
        d.state = "on";
        gameSay(`⚔️ ¡DUELO! ${d.a} vs ${d.b} a piedra, papel o tijera (al mejor de 3).`);
        pptAsk(d);
      });
      socket.on("duel-pick", ({ id, pick: choice } = {}) => {
        const d = duels.get(id); if (!d || d.state !== "on" || d.kind !== "ppt" || ![d.a, d.b].includes(c.nick)) return;
        if (!PPT_EMO[choice] || d.picks[c.nick]) return;
        d.picks[c.nick] = choice;
        if (!d.picks[d.a] || !d.picks[d.b]) return notice(socket.id, "Elegiste. Esperando al otro… 🤐");
        const pa = d.picks[d.a], pb = d.picks[d.b];
        const beats = { piedra: "tijera", papel: "piedra", tijera: "papel" };
        let res;
        if (pa === pb) res = "¡Empate! 🤝";
        else { const w = beats[pa] === pb ? d.a : d.b; d.wins[w] = (d.wins[w] || 0) + 1; res = `gana ${w}`; }
        gameSay(`⚔️ ${d.a} ${PPT_EMO[pa]} vs ${PPT_EMO[pb]} ${d.b} → ${res} (${d.wins[d.a] || 0}-${d.wins[d.b] || 0})`);
        if ((d.wins[d.a] || 0) >= (d.need || 2)) return finishDuel(d, d.a, d.b);
        if ((d.wins[d.b] || 0) >= (d.need || 2)) return finishDuel(d, d.b, d.a);
        pptAsk(d);
      });
    }
  }

  // Alguien se fue del chat: limpia lo que tenía pendiente en esta sala
  function leave(c) {
    for (const d of [...duels.values()]) if (d.a === c.nick || d.b === c.nick) {
      if (d.tour) { gameSay(`🏟️ ${c.nick} se desconectó: pierde por abandono.`); finishDuel(d, d.a === c.nick ? d.b : d.a, c.nick); continue; }
      if (d.kind === "trivia" && d.state === "on" && triviaRound?.duel?.id === d.id) { triviaRound = null; endGame(); }
      gameSay(`⚔️ Duelo ${d.a} vs ${d.b} cancelado: ${c.nick} se desconectó.`); duelExpire(d);
    }
    if (game?.type === "vor" && game.current === c.nick && ["choose", "asking", "asking-open", "doing", "vote"].includes(game.phase)) {
      vorPenalize(c.nick, "se fue en medio de su turno 🏃", c); vorClear(); game.phase = "next"; game.timers.push(setTimeout(vorNext, 2500));
    }
    if (game?.type === "impostor" && game.impostor === c.nick) { gameSay(`🫣 ${c.nick} se fue… ¡y era el impostor! Fin del juego.`); endGame(); }
    if (game?.type === "asesinato" && game.culprit === c.nick) { gameSay(`🔪 ${c.nick} huyó de la escena… ¡era el asesino! Fin del juego.`); endGame(); }
    if (game?.type === "juicio" && game.acusado === c.nick) { gameSay(`⚖️ ${c.nick} se fugó del tribunal 🏃 Juicio suspendido.`); endGame(); }
    if (game?.type === "dibujo" && game.drawer === c.nick) { gameSay(`🖍️ ${c.nick} se desconectó mientras dibujaba.`); endPicRound(null); }
  }

  function eventTrivia(e) {
    if (game) return;
    triviaRound = { left: e.action.count, total: e.action.count, temas: e.action.temas || [], scores: new Map() };
    gameSay(`🏁 Evento: ${e.title}. RONDA de ${e.action.count} preguntas${e.action.temas?.length ? " sobre " + e.action.temas.join(", ") : ""}. ¡Atentos!`);
    setTimeout(() => startTrivia(roundTema()), 3000);
  }

  // Mensajes de la sala que son jugadas (no se publican como mensaje normal)
  const intercept = (c, sid, text) => picIntercept(c, sid, text) || vorIntercept(c, sid, text) || rotosIntercept(c, sid, text) ||
    turingIntercept(c, sid, text) || fibIntercept(c, sid, text) || impIntercept(c, sid, text);
  const recent = (nick) => recentPlayers.set(nick, now());

  return { ROOM, KIND, get game() { return game; }, command: gameCommand, guess: gameGuess, intercept, recent, bind, leave, eventTrivia };
}
const ENG = {
  trivia: makeEngine("j-trivia", "trivia"),
  ia: makeEngine("j-ia", "ia"),
  fiesta: makeEngine("j-fiesta", "fiesta"),
  duelos: makeEngine("j-duelos", "duelos"),
};
const ENGINES = Object.values(ENG);
const ENGINE_BY_ROOM = Object.fromEntries(ENGINES.map((e) => [e.ROOM, e]));

// ================== Charla al azar ==================
let randomQueue = []; // socket ids esperando
const lastPartner = new Map(); // apodo -> último compañero

// ================== Pizarra compartida ==================
const BOARD_W = 900, BOARD_H = 1200, MAX_PIECES = 15000;
let board = []; // { s: id del trazo, by, c: color, w: grosor, p: [x,y,x,y,...] }
const COLOR_RE = /^#[0-9a-f]{6}$/i;
function boardRemove(pred) {
  const removed = new Set();
  board = board.filter((pc) => (pred(pc) ? (removed.add(pc.s), false) : true));
  return [...removed];
}

// ================== Eventos programados ==================
let events = []; // { id, title, ts, weekly, action: null | { type: "trivia", count, temas } , warned }
const publicEvents = () => events.filter((e) => e.ts > now() - 3600000).sort((a, b) => a.ts - b.ts)
  .map(({ id, title, ts, weekly, action, by }) => ({ id, title, ts, weekly, action, by }));
const pushEvents = () => io.emit("events", publicEvents());
const fmtWhen = (ts) => new Date(ts).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", weekday: "long", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
setInterval(() => {
  const t = now(); let changed = false;
  for (const e of [...events]) {
    if (!e.warned && t >= e.ts - 15 * 60000 && t < e.ts) {
      e.warned = true; changed = true;
      io.emit("announce", { text: `⏰ En 15 minutos: ${e.title}`, ts: t });
    }
    if (t >= e.ts) {
      changed = true;
      if (t - e.ts < 10 * 60000) { // si el servidor estuvo dormido mucho tiempo, no anuncia tarde
        io.emit("announce", { text: `📅 ¡Empieza! ${e.title}${e.action?.type === "trivia" ? " — vengan a 🎮 Juegos › 🧠 Trivia" : ""}`, ts: t });
        if (e.action?.type === "trivia") ENG.trivia.eventTrivia(e);
      }
      if (e.weekly) { while (e.ts <= t) e.ts += 7 * 24 * 3600000; e.warned = false; }
      else events = events.filter((x) => x !== e);
    }
  }
  if (changed) { dirty(); pushEvents(); }
}, 30000);

// ================== Conexiones ==================
io.on("connection", (socket) => {
  // Blindaje: si un mensaje raro (o un error nuestro) rompe un handler, se registra y el servidor sigue.
  // Antes un solo error tiraba el servidor entero y TODOS veían "Conexión perdida".
  socket.data.ip = realIp(socket.handshake.headers, socket.handshake.address);
  connCount.set(socket.data.ip, (connCount.get(socket.data.ip) || 0) + 1);
  socket.conn.on("close", () => { const n = (connCount.get(socket.data.ip) || 1) - 1; if (n > 0) connCount.set(socket.data.ip, n); else connCount.delete(socket.data.ip); });
  const rawOn = socket.on.bind(socket);
  socket.on = (ev, fn) => rawOn(ev, (...args) => {
    if (ev !== "disconnect" && !takeToken(socket, ev)) { const cb = args[args.length - 1]; if (typeof cb === "function" && /^(join|resume|muro-|private-message|public-message)/.test(ev)) cb({ ok: false, error: "Vas muy rápido. Esperá un momento." }); return; }
    try {
      const r = fn(...args.map((x) => (x === null ? undefined : x)));
      if (r && typeof r.catch === "function") r.catch((e) => console.error(`Error en "${ev}":`, e));
    } catch (e) { console.error(`Error en "${ev}":`, e); }
  });
  const ip = realIp(socket.handshake.headers, socket.handshake.address);
  const banHit = banFind(null, String(socket.handshake.auth?.dev || "").slice(0, 40));
  if (banHit) {
    socket.emit("kicked", { reason: banHit.reason || "Estás baneado/a.", ban: true, mins: banHit.until >= FOREVER / 2 ? -1 : Math.ceil((banHit.until - now()) / 60000) });
    return setTimeout(() => socket.disconnect(true), 300);
  }

  const c = {
    nick: "", status: "disponible", admin: false, owner: false, ip, dev: String(socket.handshake.auth?.dev || "").slice(0, 40), joinedAt: 0, strikes: [], mutes: 0, mutedUntil: 0,
    msgTimes: [], lastText: "", repeat: 0, lastMsgAt: 0, lastMediaAt: 0, lastCrisis: 0, adminTries: 0, blocked: new Set(),
  };
  if (passOk(c.dev, socket.handshake.auth?.pass)) c.human = true;
  clients.set(socket.id, c);
  muroHandlers(socket, c);
  logrosHandlers(socket, c);
  permHandlers(socket, c);
  shopHandlers(socket, c);
  bdayHandlers(socket, c);
  for (const E of ENGINES) E.bind(socket, c);
  socket.on("game-custom", (o = {}, cb) => { if (!Object.values(CUSTOM_OF).flat().includes(o.type)) cb && cb({ ok: false, error: "Juego desconocido." }); });

  // Volver después de minimizar: recupera la misma sesión (apodo, rango, juegos) y lo que se perdió
  socket.on("resume", (token, cb) => {
    if (typeof cb !== "function") return;
    if (c.nick) return cb({ ok: false });
    const ses = sessions.get(String(token || ""));
    if (!ses || ses.c.gone) return cb({ ok: false });
    const old = ses.c, oldId = ses.id;
    const pu = penUntil(chatPenalties, c, old.nick);
    if (pu) return cb({ ok: false });
    clearTimeout(ses.timer); ses.timer = null; clearTimeout(ses.byeTimer);
    ghostIds.delete(oldId);
    // si la conexión vieja seguía abierta (volvió antes de que el servidor notara el corte), la cerramos sin despedirlo
    const oldSock = io.sockets.sockets.get(oldId);
    if (oldSock && oldSock.id !== socket.id) { old.replaced = true; oldSock.disconnect(true); }
    const keep = { ip: c.ip, dev: c.dev || old.dev };
    Object.assign(c, old, keep, { away: false, replaced: false, msgTimes: [] });
    clients.delete(oldId); clients.set(socket.id, c);
    users.set(c.nick.toLowerCase(), socket.id);
    ses.c = c; ses.id = socket.id;
    achJoin(c);
    const replay = ses.buf; ses.buf = []; ses.bytes = 0;
    cb({ ok: true, nick: c.nick, token: c.token, users: userList(c), pinned, slowMode, locked: [...lockedRooms], events: publicEvents(), replay, away: Math.round((now() - (old.awayAt || now())) / 1000) });
    if (c.admin) socket.emit("admin", { mod: true, owner: !!c.owner });
    sendPerm(c, socket.id); if (c.admin) requestsCount();
    pushUsers();
  });

  // Salir a propósito (botón 🚪): se va en el momento, sin quedar 💤
  socket.on("leave", () => { if (!c.nick) return; c.gone = true; socket.disconnect(true); });

  socket.on("verify", async (token, cb) => {
    if (typeof cb !== "function") return;
    if (!TURNSTILE_SECRET) return cb({ ok: true });
    if (c.human) return cb({ ok: true, pass: c.dev ? makePass(c.dev) : "" });
    if (tooMany("verify", c.ip, 20)) return cb({ ok: false });
    c.human = await verifyHuman(token, c.ip);
    cb({ ok: c.human, pass: c.human && c.dev ? makePass(c.dev) : "" });
  });

  socket.on("join", (rawNick, cb) => {
    if (typeof cb !== "function") return;
    if (c.nick) return cb({ ok: true, nick: c.nick, token: c.token, users: userList(c), pinned, slowMode, locked: [...lockedRooms], events: publicEvents() });
    if (tooMany("join", c.ip, SEC.maxJoinsPerMin)) return cb({ ok: false, error: "Demasiadas entradas desde tu conexión. Esperá un minuto." });
    if (TURNSTILE_SECRET && !c.human) return cb({ ok: false, error: "🤖 Un segundo: estamos verificando que no seas un bot…", captcha: true });
    const nick = String(rawNick || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if (nick.length < 2) return cb({ ok: false, error: "El apodo tiene que tener al menos 2 caracteres." });
    if (!/^[\p{L}\p{N} _.\-]+$/u.test(nick)) return cb({ ok: false, error: "Usá solo letras, números, espacios, punto, guion o guion bajo." });
    if (RESERVED.includes(norm(nick)) || norm(nick).includes("fastidio")) return cb({ ok: false, error: "Ese apodo no se puede usar." });
    if (censor(nick).hits) return cb({ ok: false, error: "Elegí otro apodo." });
    if (users.has(nick.toLowerCase())) return cb({ ok: false, error: "Ese apodo ya está en uso." });
    if (banFind(null, null, nick)) return cb({ ok: false, error: "Ese apodo está baneado." });
    // Baneo por IP: frena a los que vuelven con otro apodo y celu "limpio", pero no a los habituales
    // que comparten IP con la persona baneada (en los celus pasa seguido).
    if (!c.admin && banFind(c.ip)) { const old = profiles.get(pkeyOf(nick, c.dev || c.ip)); if (!old || (old.xp || 0) < 30) return cb({ ok: false, error: "No se puede entrar desde esta conexión por un rato. Si sos habitual del chat, probá más tarde." }); }
    const pu = penUntil(chatPenalties, c, nick);
    if (pu) {
      const mins = Math.ceil((pu - now()) / 60000);
      socket.emit("kicked", { reason: "Penalización de Verdad o reto.", ban: true, mins });
      setTimeout(() => socket.disconnect(true), 300);
      return cb({ ok: false, error: `Estás penalizado/a. Faltan ${mins} min.` });
    }

    c.nick = nick; c.joinedAt = now();
    achJoin(c);
    c.token = newToken();
    sessions.set(c.token, { c, id: socket.id, timer: null, buf: [], bytes: 0 });
    users.set(nick.toLowerCase(), socket.id);
    cb({ ok: true, nick, token: c.token, users: userList(c), pinned, slowMode, locked: [...lockedRooms], events: publicEvents() });
    sendPerm(c, socket.id); if (c.admin) requestsCount();
    setTimeout(() => entryAnnounce(c), 600);
    emitFrom(c, "user-joined", nick, true);
    pushUsers();
  });

  socket.on("public-message", (payload) => {
    if (!c.nick) return;
    const p = typeof payload === "string" ? { text: payload } : payload || {};
    const room = ROOMS.includes(p.room) ? p.room : "general";
    if (room === "mods" && !c.admin) return;
    const raw = String(p.text || "").trim();
    if (raw.startsWith("/") && !p.image && !p.gif && !p.audio) { if (isGameRoom(room) && juegosBanNotice(c, socket.id)) return; return runCommand(c, socket.id, raw, room); }
    const hasMedia = !!(p.image || p.gif || p.audio);
    const text = checkMessage(c, socket.id, raw, room, hasMedia);
    if (text === null) return;
    const media = checkMedia(c, socket.id, p);
    if (!media) return;
    // Fotos: solo con permiso de un moderador
    if (media.image && !canPhoto(c)) { sendPerm(c, socket.id); return notice(socket.id, NO_PHOTO, "warn"); }
    const GE = ENGINE_BY_ROOM[room];
    if (GE && text && GE.intercept(c, socket.id, text)) return;
    if (GE) GE.recent(c.nick);
    publishPublic(c, room, text, media, p.replyTo);
    if (GE && text) GE.guess(c.nick, text);
    achMessage(c, room, text);
  });

  socket.on("private-message", ({ to, text: raw, replyTo, image, gif, audio } = {}, cb) => {
    if (!c.nick || typeof cb !== "function") return;
    if (String(raw || "").trim().startsWith("/") && !image && !gif && !audio) { runCommand(c, socket.id, String(raw).trim()); return cb({ ok: false, silent: true }); }
    const target = byNick(to);
    if (!target) return cb({ ok: false, error: "Ese usuario se desconectó." });
    if (blockedPair(c, target.c)) return cb({ ok: false, error: c.blocked.has(target.c.nick.toLowerCase()) ? `Tenés bloqueado/a a ${target.c.nick}. Desbloqueá para escribirle.` : "No podés enviarle mensajes a esta persona." });
    const text = checkMessage(c, socket.id, raw, "private", !!(image || gif || audio));
    if (text === null) return cb({ ok: false, silent: true });
    if (image && !canPhoto(c)) { sendPerm(c, socket.id); return cb({ ok: false, error: NO_PHOTO }); }
    const media = checkMedia(c, socket.id, { image, gif, audio });
    if (!media) return cb({ ok: false, silent: true });
    const id = newId();
    remember(id, { chat: "private", from: c.nick, to: target.c.nick, text: text || mediaLabel(media), cap: text || "", mh: mediaHash(media), ts: now(), media: !!(media.image || media.gif || media.audio) });
    const reply = buildReply(replyTo, null, c.nick, target.c.nick);
    const msg = { id, from: c.nick, to: target.c.nick, admin: c.admin, role: role(c), text, ...media, reply, ts: now() };
    io.to(target.id).emit("private-message", msg);
    cb({ ok: true, msg });
  });

  // ---- ↪️ Reenviar (como en WhatsApp): de una sala o un privado, a hasta 5 personas ----
  socket.on("forward", ({ id, to, image, gif, audio } = {}, cb) => {
    if (!c.nick || typeof cb !== "function") return;
    const m = messages.get(String(id || ""));
    if (!m) return cb({ ok: false, error: "Ese mensaje ya no existe (se borró o es muy viejo)." });
    const names = [...new Set((Array.isArray(to) ? to : [to]).map((x) => String(x || "")).filter(Boolean))].slice(0, 5);
    if (!names.length) return cb({ ok: false, error: "Elegí a quién reenviarlo." });
    // de dónde viene y a quién se le atribuye (sin revelar nunca a quien confesó)
    let fwd;
    if (m.chat === "mods") return cb({ ok: false, error: "Los mensajes de la sala de moderación no se reenvían." });
    if (m.chat === "private") {
      if (c.nick !== m.from && c.nick !== m.to) return cb({ ok: false, error: "No podés reenviar eso." });
      fwd = m.from === c.nick ? { from: c.nick } : {};
    } else if (m.chat === "confesiones") fwd = { from: "Anónimo", room: "🤫 Confesiones" };
    else fwd = { from: m.from, room: FRASE_ROOMS[m.chat] || "# " + m.chat };
    // el contenido tiene que ser el del mensaje original
    const media = m.media ? checkMedia(c, socket.id, { image, gif, audio }) : {};
    if (m.media) {
      if (!m.mh) return cb({ ok: false, error: "Ese tipo de mensaje no se puede reenviar." });
      if (!media) return cb({ ok: false, silent: true });
      if (mediaHash(media) !== m.mh) return cb({ ok: false, error: "No se pudo reenviar ese archivo." });
      if (media.image && !canPhoto(c)) { sendPerm(c, socket.id); return cb({ ok: false, error: NO_PHOTO }); }
    }
    const raw = m.media ? (m.cap || "") : m.fullText || m.text;
    const text = checkMessage(c, socket.id, raw, "private", !!m.media);
    if (text === null) return cb({ ok: false, silent: true });
    const sent = [], errors = [];
    for (const n of names) {
      const target = byNick(n);
      if (!target || target.id === socket.id) { errors.push(`${n}: no está conectado/a.`); continue; }
      if (blockedPair(c, target.c)) { errors.push(`${target.c.nick}: no le podés escribir.`); continue; }
      const nid = newId();
      remember(nid, { chat: "private", from: c.nick, to: target.c.nick, text: text || mediaLabel(media), cap: text || "", mh: m.mh || "", ts: now(), media: !!m.media });
      const msg = { id: nid, from: c.nick, to: target.c.nick, admin: c.admin, role: role(c), text, ...media, fwd, ts: now() };
      io.to(target.id).emit("private-message", msg);
      sent.push(msg);
    }
    cb({ ok: sent.length > 0, msgs: sent, errors, error: sent.length ? "" : errors.join(" ") });
  });

  socket.on("typing", ({ to, room, on } = {}) => {
    if (!c.nick || c.mutedUntil > now()) return;
    if (!to) {
      const r = ROOMS.includes(room) ? room : "general";
      if (r === "confesiones") return;
      if (r === "mods") { if (c.admin) for (const [sid, rc] of clients) if (rc.admin && rc !== c) io.to(sid).emit("typing", { from: c.nick, chat: "#mods", on: !!on }); return; }
      return emitFrom(c, "typing", { from: c.nick, chat: "#" + r, on: !!on }, true);
    }
    const target = byNick(to);
    if (target && !blockedPair(c, target.c)) io.to(target.id).emit("typing", { from: c.nick, chat: c.nick, on: !!on });
  });

  socket.on("reauth", (key) => {
    if (!c.nick || c.admin || typeof key !== "string" || c.adminTries >= 5) return;
    if (tooMany("admin", c.ip, 8, 15 * 60000)) return;
    c.adminTries++;
    key = key.trim();
    if (ADMIN_PASSWORD && key === ADMIN_PASSWORD) { c.admin = true; c.owner = true; }
    else if (modKeys.has(key)) { c.admin = true; c.modKey = key; }
    else return io.to(socket.id).emit("admin-fail");
    pushUsers(); io.to(socket.id).emit("admin", { mod: true, owner: c.owner });
  });

  socket.on("status", (s) => {
    if (!c.nick || !STATUSES.includes(s)) return;
    c.status = s; pushUsers();
  });

  socket.on("react", ({ id, emoji } = {}) => {
    if (!c.nick || !REACTIONS.includes(emoji)) return;
    const m = messages.get(id);
    if (!m) return;
    if (m.chat === "private" && c.nick !== m.from && c.nick !== m.to) return;
    if (m.chat === "mods" && !c.admin) return;
    const set = (m.reactions[emoji] ||= new Set());
    set.has(c.nick) ? set.delete(c.nick) : set.add(c.nick);
    if (!set.size) delete m.reactions[emoji];
    const payload = { id, reactions: Object.fromEntries(Object.entries(m.reactions).map(([e, s]) => [e, [...s]])) };
    if (m.chat === "mods") emitToMods("reactions", payload);
    else if (m.chat !== "private") { io.emit("reactions", payload); checkReactFrase(id, m); }
    else [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("reactions", payload); });
  });

  // ---- Decidí por mí ----
  socket.on("poll-create", ({ room, question, options, minutes } = {}, cb) => {
    if (!c.nick) return;
    room = ["general", ...GAME_ROOMS, "voz", "confesiones"].includes(room) ? room : "general";
    const q = checkMessage(c, socket.id, String(question || "").slice(0, 200), room);
    if (q === null) return cb && cb({ ok: false });
    if (q.length < 3) return cb && cb({ ok: false, error: "Escribí el dilema." });
    let opts = (Array.isArray(options) ? options : []).map((o) => censor(String(o || "").trim().slice(0, 60)).text).filter(Boolean);
    opts = [...new Set(opts)].slice(0, 6);
    if (opts.length < 2) opts = ["Sí", "No"];
    if ([...polls.values()].some((p) => p.author === c.nick)) return cb && cb({ ok: false, error: "Ya tenés una votación abierta. Esperá a que termine." });
    const mins = Math.min(10, Math.max(1, parseInt(minutes) || 2));
    const id = newId(), endsAt = now() + mins * 60000;
    const p = { room, author: c.nick, question: q, options: opts, votes: new Map(), endsAt };
    p.timer = setTimeout(() => endPoll(id), mins * 60000);
    polls.set(id, p);
    remember(id, { chat: room, from: c.nick, text: "🗳️ " + q, ts: now(), media: true });
    const poll = { options: opts, counts: opts.map(() => 0), endsAt };
    if (room === "confesiones") {
      const anon = { id, room, from: "Anónimo", anon: true, text: q, poll, ts: now() };
      for (const [sid, rc] of clients) { if (!rc.nick || blockedPair(rc, c)) continue; io.to(sid).emit("public-message", rc === c ? { ...anon, mine: true } : rc.admin ? { ...anon, realFrom: c.nick } : anon); }
    } else emitFrom(c, "public-message", { id, room, from: c.nick, admin: c.admin, role: role(c), text: q, poll, ts: now() });
    cb && cb({ ok: true });
  });
  socket.on("poll-vote", ({ id, idx } = {}) => {
    const p = polls.get(id); if (!p || !c.nick) return;
    if (p.exclude?.includes(c.nick)) return notice(socket.id, "En esta votación no podés votar vos 😅");
    if (isGameRoom(p.room) && juegosBanNotice(c, socket.id)) return;
    idx = parseInt(idx); if (!(idx >= 0 && idx < p.options.length)) return;
    p.votes.set(c.nick, idx);
    const counts = pollCounts(p);
    io.emit("poll-update", { id, counts });
  });

  // ---- Perfil (foto + frase) ----
  socket.on("profile", ({ avatar, bio } = {}, cb) => {
    if (!c.nick) return;
    if (bio !== undefined) {
      const r = censor(String(bio || "").trim().replace(/\s+/g, " ").slice(0, 80));
      if (r.harm && !c.admin) { cb && cb({ ok: false, error: "Esa frase no está permitida." }); }
      else c.bio = r.text;
    }
    if (avatar === null) { c.avatar = null; }
    else if (avatar !== undefined) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(avatar));
      if (c.noAvatar && !c.admin) { cb && cb({ ok: false, error: "Un moderador te sacó el permiso de poner foto de perfil." }); }
      else if (!m || avatar.length > 120000) { cb && cb({ ok: false, error: "La imagen no es válida o es muy pesada." }); }
      else if (!canPhoto(c)) { pushUsers(); return cb && cb({ ok: false, error: NO_PHOTO, needPerm: true }); }
      else { c.avatar = Buffer.from(m[2], "base64"); c.avatarType = m[1]; c.avVer = now(); }
    }
    pushUsers();
    cb && cb({ ok: true });
  });

  // ---- Charla al azar ----
  let randomTimer = null;
  socket.on("random-join", () => {
    if (!c.nick || randomQueue.includes(socket.id)) return;
    const candidates = randomQueue.filter((sid) => { const o = clients.get(sid); return o && o.nick && !blockedPair(c, o); });
    const fresh = candidates.filter((sid) => lastPartner.get(c.nick) !== clients.get(sid).nick);
    const partner = (fresh.length ? fresh : candidates)[0];
    if (partner) {
      randomQueue = randomQueue.filter((x) => x !== partner);
      const o = clients.get(partner);
      lastPartner.set(c.nick, o.nick); lastPartner.set(o.nick, c.nick);
      io.to(partner).emit("random-match", { nick: c.nick });
      socket.emit("random-match", { nick: o.nick });
      return;
    }
    randomQueue.push(socket.id);
    socket.emit("random-wait");
    clearTimeout(randomTimer);
    randomTimer = setTimeout(() => { if (randomQueue.includes(socket.id)) { randomQueue = randomQueue.filter((x) => x !== socket.id); socket.emit("random-timeout"); } }, 120000);
  });
  socket.on("random-cancel", () => { randomQueue = randomQueue.filter((x) => x !== socket.id); clearTimeout(randomTimer); });

  // ---- Canales de voz ----
  socket.on("voice-join", (room) => {
    if (!c.nick || !VOICE_ROOMS.includes(room)) return;
    if (room === "mods" && !c.admin) return;
    if (c.mutedUntil > now() && !c.admin) return notice(socket.id, "🔇 Estás silenciado/a: no podés entrar a la voz.", "warn");
    if (c.inCall || c.callWith) return notice(socket.id, "Cortá la llamada 1 a 1 antes de entrar a la voz.");
    if (voiceOf(socket.id) === room) return;
    if (voice.get(room).size >= VOICE_MAX) return notice(socket.id, `🎙️ La voz de esta sala está llena (máx. ${VOICE_MAX}).`, "warn");
    voiceLeave(socket.id);
    c.voiceMuted = false;
    const peers = [...voice.get(room)].map((sid) => ({ sid, nick: clients.get(sid)?.nick })).filter((x) => x.nick);
    voice.get(room).add(socket.id);
    socket.emit("voice-joined", { room, peers, me: socket.id });
    for (const p of peers) io.to(p.sid).emit("voice-peer-join", { sid: socket.id, nick: c.nick });
    pushVoice(room);
  });
  socket.on("voice-leave", () => voiceLeave(socket.id));
  socket.on("voice-signal", ({ to, data } = {}) => {
    const room = voiceOf(socket.id);
    if (!room || !voice.get(room).has(to) || !data || JSON.stringify(data).length > 20000) return;
    io.to(to).emit("voice-signal", { from: socket.id, nick: c.nick, data });
  });
  socket.on("voice-mute", (m) => { const room = voiceOf(socket.id); if (!room) return; c.voiceMuted = !!m; pushVoice(room); });
  socket.on("voice-invite", ({ to } = {}) => {
    const room = voiceOf(socket.id); const t = byNick(to);
    if (!room || !t || blockedPair(c, t.c) || voiceOf(t.id) === room) return;
    if (room === "mods" && !t.c.admin) return;
    io.to(t.id).emit("voice-invite", { from: c.nick, room });
    notice(socket.id, `🎙️ Invitaste a ${t.c.nick} a la voz.`);
  });
  socket.on("voice-kick", ({ nick } = {}) => {
    if (!c.admin) return; const t = byNick(nick); if (!t || (t.c.admin && !c.owner)) return;
    const room = voiceOf(t.id); if (!room) return;
    voiceLeave(t.id); notice(t.id, "🎙️ Un moderador te sacó de la voz.", "warn");
  });
  socket.on("voice-get", () => { for (const r of VOICE_ROOMS) if (r !== "mods" || c.admin) socket.emit("voice-count", { room: r, list: voiceList(r) }); });

  // ---- Llamadas de voz (solo se pasan mensajes entre los dos navegadores) ----
  const callOk = (to) => { const t = byNick(to); return t && t.id !== socket.id && !blockedPair(c, t.c) ? t : null; };
  socket.on("call-offer", ({ to, sdp } = {}) => {
    const t = callOk(to); if (!c.nick || !t || typeof sdp !== "string" || sdp.length > 20000) return socket.emit("call-failed", "No se pudo llamar a esa persona.");
    if (t.c.inCall || voiceOf(t.id)) return socket.emit("call-busy", t.c.nick);
    if (voiceOf(socket.id)) return socket.emit("call-failed", "Salí de la voz grupal antes de hacer una llamada 1 a 1.");
    c.callWith = t.c.nick;
    io.to(t.id).emit("call-incoming", { from: c.nick, sdp });
  });
  socket.on("call-answer", ({ to, sdp } = {}) => {
    const t = callOk(to); if (!t || typeof sdp !== "string" || sdp.length > 20000 || t.c.callWith !== c.nick) return;
    c.inCall = t.c.nick; t.c.inCall = c.nick; c.callWith = t.c.nick;
    io.to(t.id).emit("call-answered", { from: c.nick, sdp });
  });
  socket.on("call-ice", ({ to, cand } = {}) => {
    const t = callOk(to); if (!t || !cand || JSON.stringify(cand).length > 3000) return;
    if (c.callWith !== t.c.nick && t.c.callWith !== c.nick) return;
    io.to(t.id).emit("call-ice", { from: c.nick, cand });
  });
  const hangup = (to, ev = "call-ended", reason) => {
    const t = byNick(to);
    if (t && (t.c.callWith === c.nick || t.c.inCall === c.nick)) { t.c.inCall = null; t.c.callWith = null; io.to(t.id).emit(ev, { from: c.nick, reason }); }
    c.inCall = null; c.callWith = null;
  };
  socket.on("call-end", ({ to } = {}) => hangup(to));
  socket.on("call-reject", ({ to, reason } = {}) => hangup(to, "call-rejected", reason === "busy" ? "busy" : "no"));

  // ---- Pizarra ----
  let drawTimes = [];
  socket.on("board-get", () => socket.emit("board", board));
  socket.on("draw", (pc = {}) => {
    if (!c.nick || (c.mutedUntil > now() && !c.admin)) return;
    const t = now(); drawTimes = drawTimes.filter((x) => t - x < 1000);
    if (drawTimes.length > 40) return; drawTimes.push(t);
    const p = Array.isArray(pc.p) ? pc.p.slice(0, 400).map((v, i) => Math.max(0, Math.min(i % 2 ? BOARD_H : BOARD_W, Math.round(+v || 0)))) : [];
    if (p.length < 2 || !COLOR_RE.test(pc.c || "")) return;
    const piece = { s: String(pc.s || "").slice(0, 24), by: c.nick, c: pc.c, w: Math.min(60, Math.max(1, +pc.w || 4)), p };
    board.push(piece); if (board.length > MAX_PIECES) board.splice(0, board.length - MAX_PIECES);
    emitFrom(c, "draw", piece, true);
  });
  socket.on("board-undo", (sid) => { if (!c.nick) return; const r = boardRemove((pc) => pc.s === sid && pc.by === c.nick); if (r.length) io.emit("board-remove", r); });
  socket.on("board-clear-mine", () => { if (!c.nick) return; const r = boardRemove((pc) => pc.by === c.nick); if (r.length) io.emit("board-remove", r); });
  socket.on("board-clear-all", () => { if (!c.admin) return; board = []; io.emit("board", []); notifyAdmins(`${c.nick} limpió la pizarra.`); });

  // ---- Eventos ----
  socket.on("event-add", (e = {}, cb) => {
    if (!c.admin) return cb && cb({ ok: false, error: "Solo moderadores." });
    const title = String(e.title || "").trim().slice(0, 100);
    const ts = +e.ts;
    if (!title || !ts || ts < now() - 60000 || ts > now() + 365 * 24 * 3600000) return cb && cb({ ok: false, error: "Revisá el título y la fecha." });
    if (events.length >= 30) return cb && cb({ ok: false, error: "Máximo 30 eventos." });
    let action = null;
    if (e.action?.type === "trivia") action = { type: "trivia", count: Math.min(30, Math.max(3, +e.action.count || 10)), temas: (Array.isArray(e.action.temas) ? e.action.temas : []).map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 6) };
    events.push({ id: newId(), title, ts, weekly: !!e.weekly, action, by: c.nick, warned: false });
    dirty(); pushEvents();
    botSay(`📅 Nuevo evento: ${title} — ${fmtWhen(ts)}${e.weekly ? " (todas las semanas)" : ""}`);
    cb && cb({ ok: true });
  });
  socket.on("event-del", (id) => {
    if (!c.admin) return;
    const ev = events.find((x) => x.id === id); if (!ev) return;
    events = events.filter((x) => x.id !== id); dirty(); pushEvents();
    notifyAdmins(`${c.nick} borró el evento "${ev.title}".`);
  });

  socket.on("edit-message", ({ id, text: raw } = {}) => {
    const m = messages.get(String(id || ""));
    if (!m || !c.nick || m.from !== c.nick || m.media) return;
    if (now() - (m.ts || 0) > 30 * 60000) return notice(socket.id, "✏️ Solo podés editar mensajes de los últimos 30 minutos.", "warn");
    if (lockedRooms.has(m.chat) && !c.admin) return;
    if (c.mutedUntil > now()) return notice(socket.id, "🔇 Estás silenciado/a.", "warn");
    let text = String(raw || "").trim().slice(0, MAX_MSG);
    if (!text) return;
    const r = censor(text);
    if (r.harm && !c.admin) { strike(c, socket.id, 2, "Incitar a hacerse daño"); }
    text = r.text;
    m.text = text.slice(0, 160); m.fullText = text.slice(0, MAX_MSG); m.cap = text;
    { const f = frases.find((x) => x.id === id); if (f) { if (fraseOk(text)) { f.text = text.slice(0, 200); saveFrases(); } else dropFrase(id); } }
    const payload = { id, text, edited: true };
    if (m.chat === "private") [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("edited", payload); });
    else if (m.chat === "mods") emitToMods("edited", payload);
    else io.emit("edited", payload);
  });

  socket.on("delete-message", (id) => {
    const m = messages.get(id);
    if (!m || !c.nick) return;
    if (m.from !== c.nick && !(c.admin && m.chat !== "private")) return;
    messages.delete(id); dropFrase(id);
    if (m.from !== c.nick) logMod(c.nick, `🗑️ borró un mensaje de ${m.from}: «${String(m.text || "").slice(0, 80)}»`);
    if (m.chat === "mods") emitToMods("deleted", { id });
    else if (m.chat !== "private") io.emit("deleted", { id, byMod: m.from !== c.nick });
    else [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("deleted", { id }); });
  });

  socket.on("block", ({ target, on } = {}) => {
    const n = String(target || "").toLowerCase();
    if (!n) return;
    on ? c.blocked.add(n) : c.blocked.delete(n);
    if (c.nick) pushUsers();
  });

  socket.on("report", ({ target, reason } = {}, cb) => {
    const t = byNick(target);
    if (!c.nick || !t || t.id === socket.id) return cb && cb({ ok: false });
    const key = t.c.nick.toLowerCase();
    const m = reports.get(key) || new Map();
    // cuenta por celu (no por apodo): 3 apodos desde el mismo celu valen como 1 reporte
    const sameDev = c.dev && c.dev === t.c.dev;
    const fresh = now() - (c.joinedAt || now()) < 3 * 60000 && !c.veteran;
    if (!sameDev && !fresh) m.set(c.dev || "ip:" + c.ip, { ts: now(), ip: c.ip });
    for (const [k, v] of m) if (now() - v.ts > 15 * 60000) m.delete(k);
    reports.set(key, m);
    cb && cb({ ok: true });
    notifyAdmins(`${c.nick} reportó a ${t.c.nick}: ${String(reason || "sin motivo").slice(0, 200)}${fresh ? " (recién llegado/a: no cuenta para el silencio automático)" : ""}`);
    const ips = new Set([...m.values()].map((v) => v.ip));
    if (m.size >= 3 && ips.size >= 2 && !t.c.admin && t.c.mutedUntil < now()) {
      m.clear();
      mute(t.c, t.id, 10, "Varios usuarios lo/la reportaron");
    }
  });

  socket.on("disconnect", () => {
    randomQueue = randomQueue.filter((x) => x !== socket.id);
    voiceLeave(socket.id);
    if (c.replaced) return; // volvió con otra conexión
    if (!c.nick) { clients.delete(socket.id); return; }
    if (c.inCall || c.callWith) hangup(c.inCall || c.callWith);
    goAway(c, socket.id);
  });
});

// ================== 📰 Comunidad (muro) ==================
// Publicaciones que quedan guardadas (en Upstash si está configurado). Cada publicación se guarda
// en su propia clave y la foto aparte, así la base no se vuelve un solo archivo gigante.
const MURO_MAX = 300;              // publicaciones guardadas como máximo (se borran las más viejas)
const MURO_TEXT = 2000;            // largo máximo de una publicación
const MURO_COMMENTS = 200;         // comentarios por publicación
const MURO_KEY = "genterota:muro"; // lista de ids (la más nueva primero)
const postKey = (id) => `genterota:post:${id}`;
const imgKey = (id) => `genterota:img:${id}`;
const muro = [];                   // en memoria, la más nueva primero
const muroById = new Map();
const imgCache = new Map();        // id -> { buf, type }  (si no hay base de datos, quedan solo acá)
let imgCacheBytes = 0;
const IMG_DATA_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

async function redisPipe(cmds) {
  const r = await fetch(DB_URL + "/pipeline", { method: "POST", headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error(`HTTP ${r.status}`);
  const bad = j.find((x) => x && x.error); if (bad) throw new Error(bad.error);
  return j.map((x) => x?.result);
}
const muroDb = (cmds) => { if (!db.on) return; redisPipe(cmds).catch((e) => console.error("Muro DB:", e.message)); };
const savePost = (p) => muroDb([["SET", postKey(p.id), JSON.stringify(p)]]);
function cacheImg(id, buf, type) {
  if (imgCache.has(id)) imgCacheBytes -= imgCache.get(id).buf.length;
  imgCache.set(id, { buf, type }); imgCacheBytes += buf.length;
  // con base de datos, en memoria guardamos solo las últimas (~40 MB); sin base, todas
  while (db.on && imgCacheBytes > 40e6 && imgCache.size > 1) { const [k, v] = imgCache.entries().next().value; imgCache.delete(k); imgCacheBytes -= v.buf.length; }
}
async function loadMuro() {
  if (!db.on) return;
  try {
    const ids = (await redis(["LRANGE", MURO_KEY, 0, MURO_MAX - 1])) || [];
    for (let i = 0; i < ids.length; i += 100) {
      const raws = (await redis(["MGET", ...ids.slice(i, i + 100).map(postKey)])) || [];
      raws.forEach((raw) => { try { const p = JSON.parse(raw); if (p?.id) { muro.push(p); muroById.set(p.id, p); } } catch {} });
    }
    console.log(`Comunidad: ${muro.length} publicaciones cargadas`);
  } catch (e) { console.error("Muro cargar:", e.message); }
}
app.get("/muro/img/:id", async (req, res) => {
  const id = String(req.params.id).slice(0, 40);
  if (!muroById.get(id)?.img) return res.status(404).end();
  let it = imgCache.get(id);
  if (!it && db.on) {
    try {
      const raw = await redis(["GET", imgKey(id)]);
      const m = raw && String(raw).match(IMG_DATA_RE);
      if (m) { it = { buf: Buffer.from(m[2], "base64"), type: m[1] }; cacheImg(id, it.buf, it.type); }
    } catch (e) { console.error("Muro foto:", e.message); }
  }
  if (!it) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=31536000, immutable").type(it.type).send(it.buf);
});
// ¿El que mira tiene bloqueado al autor (o al revés)? Los mods ven todo.
function muroHidden(viewer, nick, authorAdmin) {
  if (!viewer || viewer.admin || authorAdmin || nick === viewer.nick) return false;
  if (viewer.blocked.has(nick.toLowerCase())) return true;
  const a = byNick(nick)?.c;
  return !!(a && a.blocked.has(viewer.nick.toLowerCase()) && !a.admin);
}
const ownsPost = (c, x) => c.admin || (x.by === c.nick && (!x.dev || !c.dev || x.dev === c.dev));
function authorAch(x) {
  const pr = profiles.get(x.pkey || pkeyOf(x.by, x.dev)); if (!pr) return {};
  const b = BADGES.find((y) => y.id === pr.show && pr.b[y.id] !== undefined);
  const ck = cosmetics(pr);
  return { lv: levelOf(pr.xp) + 1, bd: b ? b.ico : "", ...(ck ? { ck } : {}) };
}
function postView(p, viewer) {
  if (muroHidden(viewer, p.by, p.admin)) return null;
  const likes = p.likes || [];
  return {
    id: p.id, by: p.by, role: p.role || null, at: p.at, text: p.text, edited: !!p.edited, ...authorAch(p),
    img: p.img ? `/muro/img/${p.id}` : "",
    likes: likes.length, liked: likes.includes(viewer.nick), likers: likes.slice(-5).reverse(),
    comments: (p.comments || []).filter((k) => !muroHidden(viewer, k.by, k.admin))
      .map((k) => ({ id: k.id, by: k.by, role: k.role || null, at: k.at, text: k.text, mine: ownsPost(viewer, k), ...authorAch(k) })),
    mine: ownsPost(viewer, p),
  };
}
// Manda a cada persona su versión (respeta bloqueos)
function muroBroadcast(ev, p) {
  for (const [sid, rc] of clients) {
    if (!rc.nick || rc.away) continue;
    const v = postView(p, rc);
    if (v) io.to(sid).emit(ev, v);
  }
}
function muroNotify(nick, text) {
  const t = byNick(nick); if (!t) return;
  io.to(t.id).emit("muro-notif", { text });
}
// Crea una publicación del muro (también al aprobar una que estaba esperando)
function createPost(c, clean, img) {
  const t = now();
  const p = { id: newId() + t.toString(36), by: c.nick, dev: c.dev || "", pkey: c.pkey, role: role(c), admin: !!c.admin, at: t, text: clean, img: !!img, likes: [], comments: [] };
  bump(c, "posts", 1, { xp: 15, capKey: "post", cap: 45 });
  muro.unshift(p); muroById.set(p.id, p);
  if (img) cacheImg(p.id, img.buf, img.type);
  const cmds = [["SET", postKey(p.id), JSON.stringify(p)], ...(img ? [["SET", imgKey(p.id), img.data]] : []), ["LPUSH", MURO_KEY, p.id], ["LTRIM", MURO_KEY, 0, MURO_MAX - 1]];
  while (muro.length > MURO_MAX) { const old = muro.pop(); muroById.delete(old.id); imgCache.delete(old.id); cmds.push(["DEL", postKey(old.id), imgKey(old.id)]); }
  muroDb(cmds);
  muroBroadcast("muro-new", p);
}
function muroHandlers(socket, c) {
  socket.on("muro-get", ({ before } = {}, cb) => {
    if (typeof cb !== "function" || !c.nick) return;
    let start = 0;
    if (before) { const i = muro.findIndex((p) => p.id === before); start = i < 0 ? muro.length : i + 1; }
    const out = []; let i = start;
    for (; i < muro.length && out.length < 15; i++) { const v = postView(muro[i], c); if (v) out.push(v); }
    cb({ posts: out, more: i < muro.length, db: db.on });
  });
  socket.on("muro-post", ({ text, image } = {}, cb) => {
    if (typeof cb !== "function" || !c.nick) return;
    const t = now();
    if (!c.admin && t - (c.lastPostAt || 0) < 60000) return cb({ ok: false, error: `Esperá ${Math.ceil((60000 - (t - c.lastPostAt)) / 1000)} s para publicar de nuevo.` });
    let img = null;
    if (image) {
      if (!canPhoto(c)) return cb({ ok: false, error: NO_PHOTO });
      if (c.noMedia && !c.admin) return cb({ ok: false, error: "Un moderador te sacó el permiso de subir fotos." });
      if (!c.admin && t - c.joinedAt < 60000) return cb({ ok: false, error: "Podés subir fotos después de tu primer minuto en el chat." });
      const m = typeof image === "string" && image.length < 1.4e6 && image.match(IMG_DATA_RE);
      if (!m) return cb({ ok: false, error: "La foto no es válida o es muy pesada." });
      img = { buf: Buffer.from(m[2], "base64"), type: m[1], data: image };
    }
    const clean = checkMessage(c, socket.id, text, "comunidad", !!img, MURO_TEXT);
    if (clean === null) return cb({ ok: false, silent: true });
    if (!clean && !img) return cb({ ok: false, error: "Escribí algo o subí una foto." });
    c.lastPostAt = t;
    createPost(c, clean, img);
    cb({ ok: true });
  });
  socket.on("muro-like", (id) => {
    const p = muroById.get(String(id)); if (!p || !c.nick || muroHidden(c, p.by, p.admin)) return;
    const i = p.likes.indexOf(c.nick);
    if (i >= 0) p.likes.splice(i, 1); else {
      p.likes.push(c.nick);
      if (p.by !== c.nick && !(p.notified ||= []).includes(c.nick)) {
        p.notified.push(c.nick); muroNotify(p.by, `❤️ A ${c.nick} le gustó tu publicación`);
        // logros: el que da ❤️ y el que la recibe (una sola vez por persona y publicación)
        bump(c, "likesGiven", 1, { xp: 1, capKey: "likeGive", cap: 20 });
        const ak = p.pkey || pkeyOf(p.by, p.dev);
        bumpK(ak, p.by, "likesRecv", 1, { xp: 3, capKey: "likeRecv", cap: 90 });
        bumpK(ak, p.by, "maxLikes", p.notified.length, { max: true });
        if (p.notified.length >= 3) addFrase({ id: p.id, text: p.text, by: p.by, pkey: ak, at: p.at, src: "📰 Comunidad", score: p.notified.length, kind: "muro" });
      }
    }
    savePost(p); muroBroadcast("muro-upd", p);
  });
  socket.on("muro-comment", ({ id, text } = {}, cb) => {
    if (typeof cb !== "function" || !c.nick) return;
    const p = muroById.get(String(id));
    if (!p || muroHidden(c, p.by, p.admin)) return cb({ ok: false, error: "Esa publicación ya no está." });
    if ((p.comments || []).length >= MURO_COMMENTS) return cb({ ok: false, error: "Esta publicación ya tiene demasiados comentarios." });
    const clean = checkMessage(c, socket.id, text, "comunidad");
    if (!clean) return cb({ ok: false, silent: true });
    (p.comments ||= []).push({ id: newId(), by: c.nick, dev: c.dev || "", pkey: c.pkey, role: role(c), admin: !!c.admin, at: now(), text: clean });
    if (p.by !== c.nick) {
      bump(c, "comments", 1, { xp: 4, capKey: "com", cap: 60 });
      bumpK(p.pkey || pkeyOf(p.by, p.dev), p.by, "commentsRecv", 1, { xp: 2, capKey: "comRecv", cap: 40 });
    }
    savePost(p); muroBroadcast("muro-upd", p);
    if (p.by !== c.nick) muroNotify(p.by, `💬 ${c.nick} comentó tu publicación: «${clean.slice(0, 60)}${clean.length > 60 ? "…" : ""}»`);
    // también a quienes comentaron antes (sin repetir)
    [...new Set(p.comments.map((k) => k.by))].filter((n) => n !== c.nick && n !== p.by)
      .forEach((n) => muroNotify(n, `💬 ${c.nick} también comentó en la publicación de ${p.by}`));
    cb({ ok: true });
  });
  socket.on("muro-edit", ({ id, text } = {}, cb) => {
    if (typeof cb !== "function" || !c.nick) return;
    const p = muroById.get(String(id));
    if (!p || p.by !== c.nick || !ownsPost(c, p)) return cb({ ok: false, error: "Solo podés editar tus publicaciones." });
    const clean = checkMessage(c, socket.id, text, "comunidad", p.img, MURO_TEXT);
    if (clean === null) return cb({ ok: false, silent: true });
    if (!clean && !p.img) return cb({ ok: false, error: "La publicación no puede quedar vacía." });
    p.text = clean; p.edited = true;
    savePost(p); muroBroadcast("muro-upd", p);
    cb({ ok: true });
  });
  socket.on("muro-del", ({ id, cid } = {}) => {
    const p = muroById.get(String(id)); if (!p || !c.nick) return;
    if (cid) {
      const k = (p.comments || []).find((x) => x.id === cid);
      if (!k || !(ownsPost(c, k) || ownsPost(c, p))) return; // el autor del post también puede borrar comentarios en su post
      p.comments = p.comments.filter((x) => x !== k);
      savePost(p); muroBroadcast("muro-upd", p);
      return;
    }
    if (!ownsPost(c, p)) return;
    muro.splice(muro.indexOf(p), 1); muroById.delete(p.id); imgCache.delete(p.id); dropFrase(p.id);
    muroDb([["DEL", postKey(p.id), imgKey(p.id)], ["LREM", MURO_KEY, 0, p.id]]);
    io.emit("muro-del", p.id);
    if (c.admin && p.by !== c.nick) { notifyAdmins(`🗑️ ${c.nick} borró una publicación de ${p.by} en Comunidad.`); logMod(c.nick, `🗑️ borró una publicación de ${p.by} en Comunidad: «${String(p.text || "").slice(0, 80)}»`); }
  });
}

// ================== 🏅 Logros, niveles e insignias ==================
// Premian participar: charlar, publicar en el muro, que te den ❤️, comentar, jugar.
// Se guardan por apodo + celu (así nadie te "roba" los logros entrando con tu apodo desde otro lado).
const LOGROS_KEY = "genterota:logros";
const LOGROS_BOT = "Logros";
// 📣 Novedades: los logros ya no son mensajes en General; pasan unos segundos en una barrita arriba del chat.
// Cada uno puede elegir no anunciar los suyos (p.quiet).
let newsLog = [];
function news(p, ico, text) {
  if (!p || p.quiet) return;
  const n = { ico, text, nick: p.nick || "", at: now() };
  newsLog.push(n); if (newsLog.length > 30) newsLog = newsLog.slice(-30);
  io.emit("news", n);
}
const profiles = new Map();   // pkey -> perfil
const profDirty = new Set();
const LEVELS = [[0, "🩹", "Recién llegado/a"], [40, "🧩", "Pieza suelta"], [150, "🔩", "Tornillo flojo"], [400, "🔧", "En reparación"],
  [900, "🪡", "Remendado/a"], [1800, "🏺", "Kintsugi"], [3500, "💎", "Irrompible"], [7000, "👑", "Leyenda rota"]];
const TIER = ["🥉", "🥈", "🥇"];
const BADGES = [
  { id: "rompehielos", ico: "👋", name: "Rompehielos", desc: "Mandá tu primer mensaje en una sala", stat: "msgs", tiers: [1] },
  { id: "charla", ico: "🗣️", name: "Charlatán/a", desc: "Mensajes en las salas", stat: "msgs", tiers: [100, 1000, 5000] },
  { id: "muro", ico: "📰", name: "Voz del muro", desc: "Publicaciones en 📰 Comunidad", stat: "posts", tiers: [1, 10, 50] },
  { id: "querido", ico: "❤️", name: "Querido/a", desc: "❤️ que recibieron tus publicaciones", stat: "likesRecv", tiers: [10, 50, 250] },
  { id: "viral", ico: "🔥", name: "Viral", desc: "❤️ en una sola publicación", stat: "maxLikes", tiers: [5, 15, 30] },
  { id: "conversa", ico: "💬", name: "Conversador/a", desc: "Comentarios en publicaciones de otros", stat: "comments", tiers: [10, 50, 200] },
  { id: "buenaonda", ico: "🤝", name: "Buena onda", desc: "❤️ que les diste a publicaciones de otros", stat: "likesGiven", tiers: [20, 100, 400] },
  { id: "constante", ico: "📅", name: "Constante", desc: "Días seguidos entrando al chat", stat: "streak", tiers: [3, 7, 30] },
  { id: "veterano", ico: "🎂", name: "Veterano/a", desc: "Días distintos que entraste", stat: "days", tiers: [7, 30, 100] },
  { id: "cerebrito", ico: "🧠", name: "Cerebrito", desc: "Trivias y ahorcados ganados", stat: "trivia", tiers: [10, 50, 200] },
  { id: "rayo", ico: "⚡", name: "Rayo", desc: "Trivias acertadas en menos de 6 segundos", stat: "fast", tiers: [3, 15, 50] },
  { id: "valiente", ico: "🎭", name: "Valiente", desc: "Verdades o retos cumplidos en Verdad o reto", stat: "retos", tiers: [3, 15, 40] },
  { id: "detective", ico: "🕵️", name: "Detective", desc: "Veces que descubriste a la IA, al impostor o al asesino", stat: "detective", tiers: [3, 10, 30] },
  { id: "mentiroso", ico: "😈", name: "Mentiroso/a profesional", desc: "Gente que cayó en tus engaños (Mentiroso, Impostor, Asesinato)", stat: "fooled", tiers: [5, 20, 60] },
  { id: "picasso", ico: "🖍️", name: "Picasso", desc: "Veces que adivinaron tu dibujo", stat: "drawn", tiers: [5, 20, 60] },
  { id: "gladiador", ico: "⚔️", name: "Gladiador/a", desc: "Duelos ganados", stat: "duels", tiers: [3, 15, 40] },
  { id: "campeon", ico: "🏆", name: "Campeón/a", desc: "Torneos ganados (semanal o eliminatorio)", stat: "champ", tiers: [1, 3, 10] },
  { id: "buho", ico: "🦉", name: "Búho", desc: "Escribiste entre las 3 y las 6 de la mañana", stat: "owl", tiers: [1], secret: true },
  { id: "madrugador", ico: "☀️", name: "Primero del día", desc: "Fuiste la primera persona en escribir en General ese día", stat: "early", tiers: [1], secret: true },
  { id: "fenix", ico: "🪶", name: "Fénix", desc: "Volviste después de más de 2 semanas sin entrar", stat: "fenix", tiers: [1], secret: true },
];
const arDay = (t = now()) => new Date(t - 3 * 3600e3).toISOString().slice(0, 10); // día en Argentina
const arHour = (t = now()) => new Date(t - 3 * 3600e3).getUTCHours();
const levelOf = (xp) => { let i = 0; while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++; return i; };
const pkeyOf = (nick, dev) => String(nick || "").toLowerCase() + "|" + (dev || "");
function profK(pkey, nick) {
  if (!pkey) return null;
  let p = profiles.get(pkey);
  if (!p) { p = { nick, xp: 0, s: {}, b: {}, d: { day: "", x: {} }, show: "", last: "", streak: 0 }; profiles.set(pkey, p); }
  if (nick) p.nick = nick;
  return p;
}
const onlineOf = (pkey) => { for (const [sid, c] of clients) if (c.pkey === pkey && c.nick && !c.away) return { id: sid, c }; return null; };
function gainXp(pkey, p, n, capKey, cap) {
  if (capKey) {
    if (p.d.day !== arDay()) p.d = { day: arDay(), x: {} };
    const used = p.d.x[capKey] || 0;
    n = Math.max(0, Math.min(n, cap - used)); p.d.x[capKey] = used + n;
  }
  if (!n) return;
  const before = levelOf(p.xp); p.xp += n; profDirty.add(pkey);
  const after = levelOf(p.xp);
  if (after > before) {
    const o = onlineOf(pkey);
    if (o) io.to(o.id).emit("logro", { kind: "level", lv: after + 1, ico: LEVELS[after][1], name: LEVELS[after][2] });
    if (after >= 2) news(p, "⬆️", `${p.nick} subió a nivel ${after + 1}: ${LEVELS[after][1]} ${LEVELS[after][2]}`);
    usersSoon();
  }
}
// Suma a una estadística (y XP), y revisa si ganó alguna insignia
function bumpK(pkey, nick, stat, n = 1, { xp = 0, cap = Infinity, capKey = stat, max = false } = {}) {
  const p = profK(pkey, nick); if (!p) return;
  p.s[stat] = max ? Math.max(p.s[stat] || 0, n) : (p.s[stat] || 0) + n;
  profDirty.add(pkey);
  if (xp) gainXp(pkey, p, xp, capKey, cap);
  // 🧩 piezas para la tienda
  const z = PZ[stat]; if (z) gainPz(pkey, p, z[0] * (max ? 1 : n), z[1], z[2]);
  if (stat === "msgs" && p.s.msgs % 10 === 0) gainPz(pkey, p, 1, "pMsg", 15);
  for (const b of BADGES) {
    if (b.stat !== stat) continue;
    const v = p.s[stat] || 0;
    let tier = -1; b.tiers.forEach((t, i) => { if (v >= t) tier = i; });
    const had = p.b[b.id] ?? -1;
    if (tier > had) { p.b[b.id] = tier; award(pkey, p, b, tier); }
  }
}
const bump = (c, stat, n, opts) => c?.pkey && bumpK(c.pkey, c.nick, stat, n, opts);
const bumpNick = (nick, stat, n, opts) => { const t = byNick(nick); if (t?.c?.pkey) bumpK(t.c.pkey, t.c.nick, stat, n, opts); };
const badgeTxt = (b, tier) => `${b.ico} ${b.name}${b.tiers.length > 1 ? " " + TIER[tier] : ""}`;
function award(pkey, p, b, tier) {
  const bonus = b.tiers.length === 1 ? 25 : [20, 60, 150][tier];
  gainXp(pkey, p, bonus);
  gainPz(pkey, p, b.tiers.length === 1 ? 25 : [25, 50, 100][tier], null, Infinity, "insignia");
  if (!p.show) p.show = b.id;
  const o = onlineOf(pkey);
  if (o) io.to(o.id).emit("logro", { kind: "badge", id: b.id, ico: b.ico, name: b.name, desc: b.desc, tier: b.tiers.length > 1 ? tier : -1, xp: bonus });
  news(p, "🏅", `${p.nick} consiguió la insignia ${badgeTxt(b, tier)}${b.secret ? " (secreta 🤫)" : ""}`);
  usersSoon();
}
let usersTimer = null;
const usersSoon = () => { if (!usersTimer) usersTimer = setTimeout(() => { usersTimer = null; pushUsers(); }, 800); };
// Lo que se muestra al lado del nombre: nivel e insignia destacada
function achInfo(c) {
  const p = c.pkey && profiles.get(c.pkey); if (!p) return {};
  const b = BADGES.find((x) => x.id === p.show && p.b[x.id] !== undefined);
  const ck = cosmetics(p);
  return { lv: levelOf(p.xp) + 1, bd: b ? b.ico : "", ...(ck ? { ck } : {}), ...(isBday(p) ? { cumple: true } : {}) };
}
// Al entrar: racha de días, Fénix y Campeón semanal
function achJoin(c) {
  c.pkey = pkeyOf(c.nick, c.dev || c.ip);
  { const old = profiles.get(c.pkey); c.veteran = !!old && (old.xp || 0) >= 30; }
  if (!c.veteran && !c.admin) {
    const t = now(); newJoins.push(t); while (newJoins.length && t - newJoins[0] > 2 * 60000) newJoins.shift();
    if (newJoins.length >= 10 && refugioUntil < t) { newJoins.length = 0; setRefugio(15, BOT); logMod("🤖 automático", "🛡️ activó modo refugio 15 min (10 apodos nuevos en 2 min)"); notifyAdmins("🛡️ Entraron 10 apodos nuevos en 2 minutos: activé el modo refugio por 15 min. Si era gente legítima, cortalo con /refugio off."); }
  }
  const p = profK(c.pkey, c.nick), today = arDay();
  if (p.last !== today) {
    const gap = p.last ? Math.round((Date.parse(today) - Date.parse(p.last)) / 86400e3) : 0;
    p.streak = gap === 1 ? (p.streak || 0) + 1 : 1;
    p.last = today; profDirty.add(c.pkey);
    bump(c, "days", 1, { xp: 10 + Math.min(p.streak, 7) * 2, capKey: "visit", cap: 30 });
    gainPz(c.pkey, p, 5 + Math.min(p.streak - 1, 5) * 2, "pVisit", 15, "visita diaria");
    bump(c, "streak", p.streak, { max: true });
    if (gap >= 14) bump(c, "fenix", 1);
  }
  achChamp(c);
  bdayCheck(c.pkey);
}
function achChamp(c) {
  const last = champions[champions.length - 1];
  if (!last || last.nick.toLowerCase() !== String(c.nick).toLowerCase()) return;
  const p = profK(c.pkey, c.nick);
  if (p.champWeek === last.week) return;
  p.champWeek = last.week; bump(c, "champ", 1, { xp: 100 });
  gainPz(c.pkey, p, 200, null, Infinity, "campeón/a de la semana");
}
// Cada mensaje en una sala (no cuentan confesiones ni privados)
let earlyDay = "";
function achMessage(c, room, text) {
  if (!c.pkey || room === "confesiones" || room === "mods") return;
  const t = now();
  if (t - (c.achMsgAt || 0) < 4000 || String(text || "").trim().length < 3) return;
  c.achMsgAt = t;
  bump(c, "msgs", 1, { xp: 1, capKey: "msg", cap: 60 });
  const h = arHour(t);
  if (h >= 3 && h < 6) bump(c, "owl", 1);
  if (room === "general" && h >= 6 && earlyDay !== arDay(t)) { earlyDay = arDay(t); bump(c, "early", 1); }
}
async function loadLogros() {
  if (!db.on) return;
  try {
    const flat = (await redis(["HGETALL", LOGROS_KEY])) || [];
    for (let i = 0; i + 1 < flat.length; i += 2) { try { profiles.set(flat[i], JSON.parse(flat[i + 1])); } catch {} }
    console.log(`Logros: ${profiles.size} perfiles cargados`);
  } catch (e) { console.error("Logros cargar:", e.message); }
}
async function saveLogros() {
  if (!db.on || !profDirty.size) return;
  const keys = [...profDirty]; profDirty.clear();
  const args = []; for (const k of keys) { const p = profiles.get(k); if (p) args.push(k, JSON.stringify(p)); }
  for (let i = 0; i < args.length; i += 200) await redisPipe([["HSET", LOGROS_KEY, ...args.slice(i, i + 200)]]).catch((e) => { console.error("Logros guardar:", e.message); keys.forEach((k) => profDirty.add(k)); });
}
setInterval(() => saveLogros(), 20000).unref();
function logrosView(p, full) {
  const lv = levelOf(p.xp);
  return {
    nick: p.nick, xp: p.xp, lv: lv + 1, ico: LEVELS[lv][1], lvName: LEVELS[lv][2], from: LEVELS[lv][0], next: LEVELS[lv + 1]?.[0] || null,
    nextName: LEVELS[lv + 1] ? `${LEVELS[lv + 1][1]} ${LEVELS[lv + 1][2]}` : "", show: p.show, streak: p.streak || 0,
    badges: BADGES.filter((b) => full || p.b[b.id] !== undefined).map((b) => {
      const got = p.b[b.id] !== undefined, hide = b.secret && !got;
      return { id: b.id, ico: hide ? "❔" : b.ico, name: hide ? "Insignia secreta" : b.name, desc: hide ? "Se descubre sola… 🤫" : b.desc,
        tier: got ? p.b[b.id] : -1, tiers: b.tiers, value: hide ? null : (p.s[b.stat] || 0), multi: b.tiers.length > 1 };
    }),
  };
}
function logrosHandlers(socket, c) {
  socket.on("news-get", (_, cb) => { if (typeof cb === "function" && c.nick) cb(newsLog.filter((n) => !c.blocked.has(n.nick.toLowerCase())).slice(-20).reverse()); });
  socket.on("news-pref", (on, cb) => {
    if (typeof cb !== "function" || !c.pkey) return;
    const p = profK(c.pkey, c.nick);
    if (typeof on === "boolean") { p.quiet = !on; profDirty.add(c.pkey); }
    cb({ on: !p.quiet });
  });
  socket.on("logros-get", (nick, cb) => {
    if (typeof cb !== "function" || !c.nick) return;
    if (!nick || nick === c.nick) return cb({ ok: true, mine: true, ...logrosView(profK(c.pkey, c.nick), true) });
    const t = byNick(nick);
    if (!t?.c?.pkey) return cb({ ok: false, error: "Solo se ven los logros de gente conectada." });
    cb({ ok: true, mine: false, ...logrosView(profK(t.c.pkey, t.c.nick), false) });
  });
  socket.on("logros-show", (id) => {
    const p = c.pkey && profiles.get(c.pkey); if (!p) return;
    p.show = id && p.b[id] !== undefined ? String(id) : ""; profDirty.add(c.pkey); pushUsers();
  });
}
function logrosTop() {
  const top = [...profiles.values()].sort((a, b) => b.xp - a.xp).slice(0, 10);
  if (!top.length) return "🏅 Todavía nadie tiene logros.";
  return "🏅 Los de más nivel:\n" + top.map((p, i) => { const lv = levelOf(p.xp); return `${["🥇", "🥈", "🥉"][i] || i + 1 + "."} ${p.nick} — ${LEVELS[lv][1]} Nivel ${lv + 1} (${p.xp} XP) · ${Object.keys(p.b).length} insignias`; }).join("\n");
}

// ================== 📷 Permiso de fotos ==================
// Para mandar fotos (en salas, en Comunidad y de perfil) hace falta que un moderador te dé permiso.
// El permiso queda guardado por apodo + celu. Los moderadores y el dueño siempre pueden.
let approvalMode = "nuevos";           // "nuevos" = hace falta permiso · "no" = cualquiera puede
const photoRequests = new Map();       // pkey -> { nick, at }
const canPhoto = (c) => c.admin || approvalMode === "no" || !!(c.pkey && profiles.get(c.pkey)?.trusted);
const NO_PHOTO = "📷 Para mandar fotos necesitás permiso de un moderador. Tocá 🙋 «Pedir permiso de fotos» en ✏️ Mi perfil (o en el 📎).";
function sendPerm(c, sid) { io.to(sid).emit("perm", { photo: canPhoto(c), asked: photoRequests.has(c.pkey) }); }
function requestsCount() { emitToMods("photo-requests", photoRequests.size); }
function setTrust(nick, on, by) {
  const t = byNick(nick); if (!t?.c?.pkey) return false;
  logMod(by, `${on ? "📷 dio" : "🚫 sacó"} permiso de fotos a ${t.c.nick}`);
  const p = profK(t.c.pkey, t.c.nick); p.trusted = on; profDirty.add(t.c.pkey);
  photoRequests.delete(t.c.pkey); requestsCount();
  notice(t.id, on ? "📷 ¡Un moderador te dio permiso para mandar fotos! Ya podés subir fotos al chat, a Comunidad y de perfil." : "📷 Un moderador te sacó el permiso de mandar fotos.", on ? "help" : "warn");
  sendPerm(t.c, t.id); pushUsers();
  notifyAdmins(`${by ? by + " " : ""}${on ? "le dio" : "le sacó"} permiso de fotos a ${t.c.nick}.`);
  return true;
}
function permHandlers(socket, c) {
  socket.on("photo-request", (_, cb) => {
    if (!c.nick || typeof cb !== "function") return;
    if (canPhoto(c)) return cb({ ok: true, already: true });
    const prev = photoRequests.get(c.pkey);
    if (prev && now() - prev.at < 10 * 60000) return cb({ ok: false, error: "Ya lo pediste. Esperá a que un moderador lo vea 🙏" });
    photoRequests.set(c.pkey, { nick: c.nick, at: now() });
    notifyAdmins(`🙋 ${c.nick} pide permiso para mandar fotos. Tocá su nombre → 📷 Dar permiso de fotos (o /permitirfotos ${c.nick}).`);
    requestsCount(); sendPerm(c, socket.id);
    cb({ ok: true });
  });
  socket.on("photo-requests-list", (_, cb) => {
    if (typeof cb !== "function" || !c.admin) return;
    cb([...photoRequests.values()].filter((r) => byNick(r.nick)).sort((a, b) => a.at - b.at));
  });
  socket.on("photo-perm", ({ nick, on, dismiss } = {}, cb) => {
    if (!c.admin) return;
    if (dismiss) {
      const t = byNick(nick); if (t?.c?.pkey) { photoRequests.delete(t.c.pkey); sendPerm(t.c, t.id); }
      for (const [k, r] of photoRequests) if (r.nick === nick) photoRequests.delete(k);
      requestsCount(); return cb && cb({ ok: true });
    }
    const ok = setTrust(String(nick || ""), !!on, c.nick);
    cb && cb(ok ? { ok: true } : { ok: false, error: "No encontré a esa persona conectada." });
  });
}

// ================== 🧩 Piezas y 🛒 Tienda ==================
// Moneda aparte del ranking: se gana participando y se gasta en cosas para lucirse (nada da ventaja en juegos).
// Se guarda en el mismo perfil que los logros (apodo + celu).
const SHOP = [
  ...[["rojo", "Rojo fuego", "#ff5c5c"], ["naranja", "Naranja", "#ff9f1c"], ["oro", "Amarillo roto", "#ffd400"], ["lima", "Verde lima", "#7ed957"], ["turquesa", "Turquesa", "#2ec4b6"],
    ["celeste", "Celeste", "#4cc9f0"], ["azul", "Azul eléctrico", "#5b8cff"], ["violeta", "Violeta", "#a78bfa"], ["rosa", "Rosa chicle", "#ff6ec7"], ["hueso", "Blanco hueso", "#e9e4d4"]]
    .map(([id, name, val]) => ({ id: "c-" + id, cat: "color", name, price: 100, val })),
  { id: "c-kintsugi", cat: "color", name: "Nombre Kintsugi ✨ (dorado con brillo)", price: 1000, val: "k" },
  { id: "emoji", cat: "emoji", name: "Emoji de firma", price: 80 },
  { id: "title", cat: "title", name: "Título personalizado", price: 300 },
  ...[["oro", "Marco dorado"], ["fuego", "Marco de fuego"], ["neon", "Marco neón"], ["grieta", "Marco grieta"]].map(([id, name]) => ({ id: "f-" + id, cat: "frame", name, price: 200 })),
  { id: "entry", cat: "entry", name: "Entrada épica", price: 150 },
  ...[["galaxia", "Galaxia"], ["lluvia", "Lluvia"], ["atardecer", "Atardecer"], ["mate", "Mate"]].map(([id, name]) => ({ id: "bg-" + id, cat: "bg", name: "Fondo " + name, price: 60 })),
];
const SHOP_BY_ID = Object.fromEntries(SHOP.map((x) => [x.id, x]));
const ENTRIES = ["🚪💥 {n} entró pateando la puerta", "🎺 Silencio todos… llegó {n}", "🌪️ {n} cayó como un huracán", "🦸 Tranquilos, {n} ya está acá",
  "🎬 Y en el papel principal… ¡{n}!", "🧉 {n} llegó con el mate listo", "👀 {n} apareció de la nada", "🪩 {n} entró bailando"];
// Cuántas piezas da cada cosa: [piezas, tope diario compartido, tope]
const PZ = { posts: [10, "pPost", 30], likesRecv: [2, "pLike", 60], comments: [2, "pCom", 30],
  trivia: [3, "pGame", 80], duels: [6, "pGame", 80], detective: [4, "pGame", 80], fooled: [3, "pGame", 80], drawn: [3, "pGame", 80],
  retos: [4, "pGame", 80], guessed: [2, "pGame", 80], rotos: [1, "pGame", 80] };
function gainPz(pkey, p, n, capKey, cap = Infinity, why = "") {
  if (capKey) {
    if (p.d.day !== arDay()) p.d = { day: arDay(), x: {} };
    const used = p.d.x[capKey] || 0;
    n = Math.max(0, Math.min(n, cap - used)); p.d.x[capKey] = used + n;
  }
  if (!n) return;
  p.pz = (p.pz || 0) + n; profDirty.add(pkey);
  const o = onlineOf(pkey); if (o) io.to(o.id).emit("pz", { n, total: p.pz, why });
}
// Lo que se ve de cada persona: color, emoji, marco y título
function cosmetics(p) {
  const e = p?.eq; if (!e) return null;
  const o = {};
  if (e.color && SHOP_BY_ID[e.color]) o.col = SHOP_BY_ID[e.color].val;
  if (e.emoji) o.emo = e.emoji;
  if (e.frame) o.frm = e.frame.slice(2);
  if (e.title) o.tit = e.title;
  return Object.keys(o).length ? o : null;
}
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[‍️\u{1F3FB}-\u{1F3FF}])+$/u;
let lastEntry = new Map(); // pkey -> cuándo anunció su entrada (no repetir al recargar)
function entryAnnounce(c) {
  const p = c.pkey && profiles.get(c.pkey); if (!p?.eq?.entry && p?.eq?.entry !== 0) return;
  if (now() - (lastEntry.get(c.pkey) || 0) < 30 * 60000) return;
  lastEntry.set(c.pkey, now());
  const tpl = ENTRIES[p.eq.entry]; if (tpl) botSay(tpl.replace("{n}", c.nick), "general", "Portero");
}
function shopView(c) {
  const p = profK(c.pkey, c.nick);
  return { pz: p.pz || 0, inv: p.inv || [], eq: p.eq || {}, items: SHOP, entries: ENTRIES.map((t) => t.replace("{n}", c.nick)) };
}
function shopHandlers(socket, c) {
  socket.on("shop-get", (_, cb) => { if (typeof cb === "function" && c.pkey) cb(shopView(c)); });
  socket.on("shop-buy", (id, cb) => {
    if (typeof cb !== "function" || !c.pkey) return;
    const it = SHOP_BY_ID[String(id)], p = profK(c.pkey, c.nick);
    if (!it) return cb({ ok: false, error: "Ese producto no existe." });
    p.inv ||= []; p.eq ||= {};
    if (p.inv.includes(it.id)) return cb({ ok: false, error: "Ya lo tenés." });
    if ((p.pz || 0) < it.price) return cb({ ok: false, error: `Te faltan ${it.price - (p.pz || 0)} 🧩.` });
    p.pz -= it.price; p.inv.push(it.id);
    // lo deja puesto apenas lo comprás
    if (it.cat === "color") p.eq.color = it.id;
    if (it.cat === "frame") p.eq.frame = it.id;
    if (it.cat === "bg") p.eq.bg = it.id;
    if (it.cat === "entry") p.eq.entry = 0;
    profDirty.add(c.pkey); usersSoon();
    if (it.price >= 150) news(p, "🛒", `${c.nick} se compró ${it.name.replace(" ✨ (dorado con brillo)", " ✨")} en la tienda`);
    cb({ ok: true, ...shopView(c) });
  });
  socket.on("shop-equip", ({ slot, value } = {}, cb) => {
    if (typeof cb !== "function" || !c.pkey) return;
    const p = profK(c.pkey, c.nick); p.inv ||= []; p.eq ||= {};
    const has = (id) => p.inv.includes(id);
    const v = value === undefined || value === null ? "" : value;
    if (["color", "frame", "bg"].includes(slot)) {
      if (v && (!has(v) || SHOP_BY_ID[v]?.cat !== slot)) return cb({ ok: false, error: "No lo tenés." });
      p.eq[slot] = v;
    } else if (slot === "entry") {
      if (!has("entry")) return cb({ ok: false, error: "Primero comprá la entrada épica." });
      const i = parseInt(v); p.eq.entry = v === "" ? null : (i >= 0 && i < ENTRIES.length ? i : 0);
    } else if (slot === "emoji") {
      if (!has("emoji")) return cb({ ok: false, error: "Primero comprá el emoji de firma." });
      const e = String(v).trim();
      if (e && (e.length > 12 || !EMOJI_RE.test(e) || [...new Intl.Segmenter().segment(e)].length > 2)) return cb({ ok: false, error: "Elegí 1 o 2 emojis (sin letras)." });
      p.eq.emoji = e;
    } else if (slot === "title") {
      if (!has("title")) return cb({ ok: false, error: "Primero comprá el título." });
      const t = String(v).trim().replace(/\s+/g, " ").slice(0, 28);
      const r = censor(t);
      if (r.hits || /https?:|www\./i.test(t)) return cb({ ok: false, error: "Ese título no está permitido." });
      if (/(moderador|admin|dueñ|fastidio|crupier)/i.test(plain(t)) && !c.admin) return cb({ ok: false, error: "El título no puede hacerse pasar por moderación ni por los bots." });
      p.eq.title = t;
    } else return cb({ ok: false });
    profDirty.add(c.pkey); usersSoon();
    cb({ ok: true, ...shopView(c) });
  });
  socket.on("pz-gift", ({ to, amount } = {}, cb) => {
    if (typeof cb !== "function" || !c.pkey) return;
    const n = Math.floor(Number(amount));
    const t = byNick(String(to || ""));
    if (!t?.c?.pkey || t.c === c) return cb({ ok: false, error: "Elegí a alguien conectado (que no seas vos)." });
    if (t.c.dev && t.c.dev === c.dev) return cb({ ok: false, error: "No podés regalarte piezas desde el mismo celu 😉" });
    if (!(n >= 5 && n <= 500)) return cb({ ok: false, error: "Podés regalar entre 5 y 500 🧩." });
    const p = profK(c.pkey, c.nick), q = profK(t.c.pkey, t.c.nick);
    if (p.d.day !== arDay()) p.d = { day: arDay(), x: {} };
    if ((p.d.x.gift || 0) + n > 500) return cb({ ok: false, error: `Hoy ya regalaste ${p.d.x.gift || 0} 🧩 (máximo 500 por día).` });
    if ((p.pz || 0) < n) return cb({ ok: false, error: "No te alcanzan las piezas." });
    p.pz -= n; p.d.x.gift = (p.d.x.gift || 0) + n; q.pz = (q.pz || 0) + n;
    profDirty.add(c.pkey); profDirty.add(t.c.pkey);
    io.to(t.id).emit("pz", { n, total: q.pz, why: `regalo de ${c.nick}` });
    notice(t.id, `🎁 ${c.nick} te regaló ${n} 🧩. ¡Ya podés gastarlas en la 🛒 Tienda!`, "help");
    cb({ ok: true, pz: p.pz });
  });
}

// ================== ⭐ Frases célebres (para "¿Quién dijo esto?") ==================
// Solo se guardan mensajes que marcaron algo: los que recibieron reacciones de 3+ personas,
// las publicaciones de Comunidad con 3+ ❤️ y los que un moderador marca con ⭐. Nada de "hola".
const FRASES_KEY = "genterota:frases";
let frases = [];   // { id, text, by, pkey, at, src, score, kind, uses, lastUsed }
const FRASE_ROOMS = { general: "# General", "j-trivia": "🧠 Trivia", "j-ia": "🕵️ Engaño", "j-fiesta": "🎉 Fiesta", "j-duelos": "⚔️ Duelos", voz: "🎙️ Voz", comunidad: "📰 Comunidad" };
const BOT_NAMES = () => [BOT, CRUPIER, LOGROS_BOT, "Portero"];
let frasesTimer = null;
const saveFrases = () => { if (!db.on) return; clearTimeout(frasesTimer); frasesTimer = setTimeout(() => redis(["SET", FRASES_KEY, JSON.stringify(frases)]).catch((e) => console.error("Frases guardar:", e.message)), 3000); };
async function loadFrases() {
  if (!db.on) return;
  try { const raw = await redis(["GET", FRASES_KEY]); if (raw) frases = JSON.parse(raw); console.log(`Frases célebres: ${frases.length}`); } catch (e) { console.error("Frases cargar:", e.message); }
}
// ¿Sirve como frase? Que tenga sustancia: nada de saludos, links sueltos ni puro emoji
const TRIVIAL_RE = /^((hola|holis|holi|buenas|buen dia|buenos dias|buenas tardes|buenas noches|chau|chao|nos vemos|jaja\w*|jeje\w*|ja|si|no|ok|dale|gracias|que tal|como andan|como estan|todo bien)\s*)+$/;
function fraseOk(text) {
  const t = String(text || "").trim();
  if (TRIVIAL_RE.test(plain(t))) return false;
  if (t.length < 15 || t.length > 200 || t.startsWith("/")) return false;
  if (/https?:\/\/|www\./i.test(t)) return false;
  const words = plain(t).split(" ").filter((w) => w.length > 1);
  return words.length >= 3;
}
function addFrase({ id, text, by, pkey, at, src, score, kind }, byMod) {
  if (!id || !by || BOT_NAMES().includes(by)) return { ok: false, error: "Eso no puede ser frase célebre." };
  if (!byMod && !fraseOk(text)) return { ok: false, error: "Muy corta o sin sustancia." };
  if (byMod && (plain(text).length < 8 || TRIVIAL_RE.test(plain(text)))) return { ok: false, error: "Muy corta o es solo un saludo: elegí algo que se recuerde 😉" };
  const prev = frases.find((f) => f.id === id);
  if (prev) { prev.score = Math.max(prev.score || 0, score || 0); saveFrases(); return { ok: true, already: true }; }
  frases.push({ id, text: String(text).trim().slice(0, 200), by, pkey: pkey || "", at: at || now(), src, score: score || 0, kind, uses: 0, lastUsed: 0 });
  if (frases.length > 400) { frases.sort((a, b) => (b.score || 0) - (a.score || 0) || b.at - a.at); frases = frases.slice(0, 400); }
  saveFrases();
  // al autor le avisamos (y le damos unas piezas)
  const t = byNick(by);
  if (t && (!pkey || t.c.pkey === pkey)) {
    notice(t.id, `⭐ Tu ${kind === "muro" ? "publicación" : "mensaje"} «${String(text).slice(0, 60)}${String(text).length > 60 ? "…" : ""}» quedó como frase célebre de Gente Rota. Puede salir en ¿Quién dijo esto? 🗣️`, "help");
    const p = profK(t.c.pkey, t.c.nick); if (p) gainPz(t.c.pkey, p, 5, "pFrase", 15, "frase célebre");
  }
  return { ok: true };
}
const dropFrase = (id) => { const n = frases.length; frases = frases.filter((f) => f.id !== id); if (frases.length !== n) saveFrases(); };
// reacciones de 3+ personas distintas (sin contar al autor)
function checkReactFrase(id, m) {
  if (m.famous || !FRASE_ROOMS[m.chat] || m.media || BOT_NAMES().includes(m.from)) return;
  const people = new Set(); for (const s of Object.values(m.reactions)) for (const n of s) if (n !== m.from) people.add(n);
  if (people.size < 3) return;
  m.famous = true;
  addFrase({ id, text: m.fullText || m.text, by: m.from, pkey: m.pkey, at: m.ts, src: FRASE_ROOMS[m.chat], score: people.size, kind: "chat" });
}

// ================== 🎂 Cumpleaños ==================
// Cada uno carga día y mes (sin año). Ese día se anuncia, hay tarjeta colectiva y regalo de piezas.
const CARDS_KEY = "genterota:tarjetas";
let cards = {};   // "pkey|AAAA" -> { nick, msgs: [{ by, text, at }] }
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const arMD = (t = now()) => arDay(t).slice(5);          // "MM-DD"
const arYear = (t = now()) => arDay(t).slice(0, 4);
const isBday = (p) => !!p?.bday && p.bday === arMD();
async function loadCards() {
  if (!db.on) return;
  try { const raw = await redis(["GET", CARDS_KEY]); if (raw) cards = JSON.parse(raw); } catch (e) { console.error("Tarjetas cargar:", e.message); }
}
let cardsTimer = null;
function saveCards() {
  // las tarjetas viejas (más de 10 días) se borran
  const lim = arDay(now() - 10 * 86400e3);
  for (const k of Object.keys(cards)) if ((cards[k].day || "") < lim) delete cards[k];
  if (!db.on) return;
  clearTimeout(cardsTimer); cardsTimer = setTimeout(() => redis(["SET", CARDS_KEY, JSON.stringify(cards)]).catch((e) => console.error("Tarjetas guardar:", e.message)), 2000);
}
// Anuncia el cumple (una vez por año) y le regala piezas
function bdayCheck(pkey) {
  const p = profiles.get(pkey); if (!isBday(p)) return;
  const year = arYear();
  if (p.bdayYear === year) return;
  p.bdayYear = year; profDirty.add(pkey);
  const key = pkey + "|" + year;
  cards[key] ||= { nick: p.nick, day: arDay(), msgs: [] }; saveCards();
  gainPz(pkey, p, 100, null, Infinity, "regalo de cumpleaños 🎂");
  const id = newId();
  remember(id, { chat: "general", from: LOGROS_BOT, text: "cumple" });
  io.emit("public-message", { id, room: "general", from: LOGROS_BOT, bot: true, ts: now(), card: p.nick,
    text: `🎂🎉 ¡HOY CUMPLE ${p.nick.toUpperCase()}! 🎉🎂\nDejale un saludo en su tarjeta: la firman todos y se la queda de recuerdo.` });
  usersSoon();
}
// A las 10 de la mañana se anuncian los cumples de la gente activa aunque no esté conectada
setInterval(() => {
  if (arHour() < 10) return;
  const recent = arDay(now() - 60 * 86400e3);
  for (const [k, p] of profiles) if (isBday(p) && (p.last || "") >= recent) bdayCheck(k);
}, 5 * 60000).unref();
const cardKeyOf = (nick) => {
  const year = arYear();
  const t = byNick(nick);
  if (t?.c?.pkey && cards[t.c.pkey + "|" + year]) return t.c.pkey + "|" + year;
  return Object.keys(cards).find((k) => k.endsWith("|" + year) && cards[k].nick.toLowerCase() === String(nick).toLowerCase());
};
function bdayHandlers(socket, c) {
  socket.on("bday-set", ({ day, month } = {}, cb) => {
    if (typeof cb !== "function" || !c.pkey) return;
    const d = parseInt(day), m = parseInt(month);
    const p = profK(c.pkey, c.nick);
    if (!d && !m) { p.bday = ""; profDirty.add(c.pkey); return cb({ ok: true, bday: "" }); }
    const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= max)) return cb({ ok: false, error: "Esa fecha no existe." });
    if (p.bday && now() - (p.bdaySetAt || 0) < 30 * 86400e3) return cb({ ok: false, error: "Ya cargaste tu cumple. Se puede cambiar una vez por mes." });
    p.bday = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; p.bdaySetAt = now(); profDirty.add(c.pkey);
    cb({ ok: true, bday: p.bday });
    bdayCheck(c.pkey);
  });
  socket.on("bday-get", (_, cb) => { if (typeof cb === "function" && c.pkey) cb({ bday: profiles.get(c.pkey)?.bday || "" }); });
  socket.on("card-get", (nick, cb) => {
    if (typeof cb !== "function" || !c.nick) return;
    const k = cardKeyOf(nick); if (!k) return cb({ ok: false, error: "No hay tarjeta de cumpleaños para esa persona hoy." });
    const cd = cards[k];
    cb({ ok: true, nick: cd.nick, msgs: cd.msgs.filter((x) => !muroHidden(c, x.by)), signed: cd.msgs.some((x) => x.by === c.nick), mine: k.startsWith(c.pkey + "|") });
  });
  socket.on("card-sign", ({ nick, text } = {}, cb) => {
    if (typeof cb !== "function" || !c.nick) return;
    const k = cardKeyOf(nick); if (!k) return cb({ ok: false, error: "Esa tarjeta ya no está." });
    if (k.startsWith(c.pkey + "|")) return cb({ ok: false, error: "¡No podés firmar tu propia tarjeta! 😄" });
    const cd = cards[k];
    if (cd.msgs.some((x) => x.by === c.nick)) return cb({ ok: false, error: "Ya la firmaste 💛" });
    const clean = checkMessage(c, socket.id, String(text || "").slice(0, 160), "general");
    if (!clean) return cb({ ok: false, silent: true });
    cd.msgs.push({ by: c.nick, text: clean, at: now() }); saveCards();
    const t = byNick(cd.nick); if (t) io.to(t.id).emit("card-new", { by: c.nick, text: clean });
    bump(c, "cards", 1, { xp: 3, capKey: "cardXp", cap: 15 });
    cb({ ok: true });
  });
  socket.on("frase-add", (id, cb) => {
    if (!c.admin) return;
    const m = messages.get(String(id));
    if (!m || !FRASE_ROOMS[m.chat]) return cb && cb({ ok: false, error: "Ese mensaje no se puede marcar (solo de salas públicas)." });
    const r = addFrase({ id: String(id), text: m.fullText || m.text, by: m.from, pkey: m.pkey, at: m.ts, src: FRASE_ROOMS[m.chat], score: 5, kind: "chat" }, true);
    if (r.ok) m.famous = true;
    cb && cb(r);
  });
}

// Mantener despierto en Render (plan gratis)
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL && typeof fetch === "function") {
  setInterval(() => fetch(SELF_URL + "/ping").catch(() => {}), 10 * 60 * 1000);
}

// ================== Base de datos (Upstash Redis, gratis) ==================
// En Render: UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN
const DB_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const DB_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const DB_KEY = "genterota:estado";
const db = { on: !!(DB_URL && DB_TOKEN), loaded: false, lastSave: 0, lastError: "", saving: false, pending: false };
async function redis(cmd) {
  const r = await fetch(DB_URL, { method: "POST", headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j.result;
}
function snapshot() {
  const t = now();
  return {
    v: 1,
    modKeys: [...modKeys].filter(([k]) => !envModKeys.has(k)), // las de Render ya están allá
    bans: [...bans].filter(([, b]) => b.until > t), modLog,
    points: [...points],
    pinned, slowMode, badWords: BAD_WORDS, locked: [...lockedRooms], events, approvalMode,
    weekly: { start: weekly.start, points: [...weekly.points] }, champions,
  };
}
let saveTimer = null;
function dirty() {
  if (!db.on || !db.loaded) return;
  db.pending = true;
  if (saveTimer) return;
  // Guarda como mucho una vez cada 20 s (cuida el cupo gratis de 500.000 comandos/mes)
  const wait = Math.max(2000, 20000 - (now() - db.lastSave));
  saveTimer = setTimeout(saveNow, wait);
}
async function saveNow() {
  saveTimer = null;
  if (!db.on || !db.pending || db.saving) return;
  db.saving = true; db.pending = false;
  try { await redis(["SET", DB_KEY, JSON.stringify(snapshot())]); db.lastSave = now(); db.lastError = ""; }
  catch (e) { db.lastError = e.message; db.pending = true; console.error("DB guardar:", e.message); }
  finally { db.saving = false; if (db.pending) dirty(); }
}
async function loadState() {
  if (!db.on) { console.log("Base de datos: desactivada (faltan variables UPSTASH_REDIS_REST_*)"); return; }
  try {
    const raw = await redis(["GET", DB_KEY]);
    if (raw) {
      const st = JSON.parse(raw);
      (st.modKeys || []).forEach(([k, n]) => { if (!modKeys.has(k)) modKeys.set(k, n); });
      (st.bans || []).forEach(([k, b]) => {
        if (typeof b === "number") { b = { until: b, nick: "", by: "", reason: "Baneo anterior" }; k = "ip:" + k; } // formato viejo
        if (b?.until > now()) bans.set(k, b);
      });
      if (Array.isArray(st.modLog)) modLog = st.modLog.slice(-200);
      (st.points || []).forEach(([n, p]) => points.set(n, p));
      pinned = st.pinned || ""; slowMode = st.slowMode || 0;
      if (Array.isArray(st.badWords)) BAD_WORDS = st.badWords;
      if (["nuevos", "todos", "no"].includes(st.approvalMode)) approvalMode = st.approvalMode;
      (st.locked || []).forEach((r) => lockedRooms.add(r));
      if (Array.isArray(st.events)) events = st.events;
      if (st.weekly?.start === weekly.start) (st.weekly.points || []).forEach(([n, p]) => weekly.points.set(n, p));
      else if (st.weekly?.points?.length) { // la semana terminó mientras el servidor estaba apagado
        const top = [...st.weekly.points].sort((a, b) => b[1] - a[1])[0];
        if (top) (st.champions = st.champions || []).push({ nick: top[0], pts: top[1], week: st.weekly.start });
      }
      if (Array.isArray(st.champions)) champions = st.champions.slice(-20);
      console.log(`Base de datos: cargado (${modKeys.size} claves de mods, ${bans.size} baneos, ${points.size} en el ranking)`);
    } else console.log("Base de datos: conectada (vacía, primera vez)");
    db.loaded = true;
  } catch (e) { db.lastError = e.message; console.error("DB cargar:", e.message); db.loaded = true; }
}
// Un toque por día para que Upstash no archive la base por inactividad
setInterval(() => { if (db.on) redis(["GET", DB_KEY]).catch(() => {}); }, 24 * 3600000);
// Render avisa antes de apagar: guardamos lo pendiente
process.on("uncaughtException", (e) => console.error("Error no capturado (el servidor sigue):", e));
process.on("unhandledRejection", (e) => console.error("Promesa rechazada (el servidor sigue):", e));
process.on("SIGTERM", async () => { if (saveTimer) clearTimeout(saveTimer); db.pending = true; await Promise.all([saveNow().catch(() => {}), saveLogros().catch(() => {})]); process.exit(0); });

const PORT = process.env.PORT || 3000;
Promise.race([Promise.all([loadState(), loadMuro(), loadLogros(), loadFrases(), loadCards()]), new Promise((ok) => setTimeout(ok, 8000))]).finally(() =>
  server.listen(PORT, () => console.log(`Gente Rota en http://localhost:${PORT}`)));
