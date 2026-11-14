const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.set("trust proxy", true);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "Public")));
app.get("/ping", (req, res) => res.send("ok"));

// ================== Configuración ==================
const BOT = "Guardián";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""; // se configura en Render
const MAX_MSG = 500;
const STATUSES = ["disponible", "hablar", "escucho", "ausente", "nomolestar"];
const REACTIONS = ["❤️", "🫂", "👍", "😂", "😢", "🔥", "💛"];
const RESERVED = ["guardian", "admin", "administrador", "moderador", "mod", "sistema", "bot", "__general__"];

// Palabras prohibidas (raíces). El admin puede sumar/quitar con /filtro
let BAD_WORDS = [
  "puto", "puta", "putit", "pelotud", "forro", "forra", "conchud", "conchetumadre", "hdp",
  "hijodeputa", "trolo", "trola", "mogolic", "retrasad", "sorete", "garca", "malparid",
  "maricon", "tortillera", "bastard", "pajero", "chupapija", "chupame", "gil de mierda",
];
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
const userList = () =>
  [...clients.values()].filter((c) => c.nick)
    .map((c) => ({ nick: c.nick, status: c.status, admin: c.admin }))
    .sort((a, b) => a.nick.localeCompare(b.nick));
const pushUsers = () => io.emit("users", userList());

function remember(id, data) {
  messages.set(id, { ...data, reactions: {} });
  if (messages.size > 3000) messages.delete(messages.keys().next().value);
}

// ---------- Mensajes del bot ----------
function botSay(text) {
  const id = newId();
  remember(id, { chat: "general", from: BOT });
  io.emit("public-message", { id, from: BOT, bot: true, text, ts: now() });
}
const notice = (socketId, text, kind = "bot") => io.to(socketId).emit("notice", { text, kind, ts: now() });
function notifyAdmins(text) {
  for (const [id, c] of clients) if (c.admin) notice(id, "🛡️ " + text, "mod");
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
function mute(c, id, minutes, reason, by = BOT) {
  c.mutedUntil = now() + minutes * 60000;
  c.mutes++;
  notice(id, `🔇 Fuiste silenciado/a por ${minutes} min. Motivo: ${reason}`, "warn");
  botSay(`🔇 ${c.nick} fue silenciado/a ${minutes} min${by !== BOT ? " por un moderador" : ""}. Motivo: ${reason}`);
}
function kick(id, reason, ban = false, by = BOT) {
  const c = clients.get(id);
  if (!c) return;
  if (ban) bans.set(c.ip, now() + 24 * 3600000);
  io.to(id).emit("kicked", { reason, ban });
  botSay(`${ban ? "⛔" : "👢"} ${c.nick || "Alguien"} fue ${ban ? "baneado/a por 24 h" : "expulsado/a"}${by !== BOT ? " por un moderador" : ""}. Motivo: ${reason}`);
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
function checkMessage(c, id, raw) {
  let text = String(raw || "").trim().slice(0, MAX_MSG);
  if (!text) return null;
  const t = now();
  if (c.mutedUntil > t) {
    notice(id, `🔇 Estás silenciado/a. Faltan ${Math.ceil((c.mutedUntil - t) / 60000)} min.`, "warn");
    return null;
  }
  if (!c.admin) {
    if (slowMode && t - c.lastMsgAt < slowMode * 1000) {
      notice(id, `🐢 Modo lento activo: esperá ${Math.ceil((slowMode * 1000 - (t - c.lastMsgAt)) / 1000)} s.`, "warn");
      return null;
    }
    c.msgTimes = c.msgTimes.filter((x) => t - x < 8000);
    if (c.msgTimes.length >= 6) { strike(c, id, 1, "Mandar mensajes muy rápido (flood)"); return null; }
    c.msgTimes.push(t);

    const key = norm(text);
    c.repeat = key === c.lastText ? c.repeat + 1 : 0;
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
  const r = censor(text);
  if (r.hits && !c.admin) strike(c, id, r.harm ? 2 : 1, r.harm ? "Incitar a hacerse daño" : "Insultos o lenguaje ofensivo");
  // Señales de crisis: ayuda privada (máx. una vez cada 10 min) + aviso a moderadores
  if (CRISIS_RE.test(norm(text)) && t - c.lastCrisis > 10 * 60000) {
    c.lastCrisis = t;
    notice(id, HELP_TEXT, "help");
    notifyAdmins(`${c.nick} puede estar pasando un momento difícil. Quizás quieras escribirle.`);
  }
  return r.text;
}

// ---------- Comandos (/algo) ----------
function runCommand(c, id, text) {
  const [cmdRaw, ...rest] = text.slice(1).split(" ");
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(" ").trim();

  if (cmd === "ayuda") {
    let help = "Comandos: /ayuda · /reglas · /admin <clave>";
    if (c.admin) help += "\nModeración: /silenciar <apodo> [min] · /desilenciar <apodo> · /expulsar <apodo> [motivo] · /banear <apodo> [motivo] · /desbanear-todo · /fijar <texto> · /desfijar · /anuncio <texto> · /lento <seg> · /limpiar · /filtro +palabra | -palabra | lista · /reportes";
    return notice(id, help);
  }
  if (cmd === "admin") {
    if (!ADMIN_PASSWORD) return notice(id, "El modo admin no está configurado en el servidor.");
    if (c.adminTries >= 5) return notice(id, "Demasiados intentos.");
    c.adminTries++;
    if (arg !== ADMIN_PASSWORD) return notice(id, "Clave incorrecta.", "warn");
    c.admin = true;
    pushUsers();
    io.to(id).emit("admin", true);
    return notice(id, "🛡️ Sos moderador/a. Escribí /ayuda para ver los comandos.", "mod");
  }
  if (!c.admin) return notice(id, "Comando desconocido o sin permiso. Probá /ayuda.");

  const [targetNick, ...why] = arg.split(" ");
  const reason = why.join(" ") || "Decisión de moderación";
  const target = byNick(targetNick);

  switch (cmd) {
    case "silenciar": case "mute": {
      if (!target) return notice(id, "No encuentro a ese usuario.");
      const min = Math.min(1440, Math.max(1, parseInt(why[0]) || 10));
      return mute(target.c, target.id, min, why.slice(1).join(" ") || "Decisión de moderación", c.nick);
    }
    case "desilenciar": case "unmute":
      if (!target) return notice(id, "No encuentro a ese usuario.");
      target.c.mutedUntil = 0; target.c.strikes = [];
      notice(target.id, "🔊 Ya podés volver a escribir.");
      return notice(id, `${target.c.nick} ya puede escribir.`, "mod");
    case "expulsar": case "kick":
      if (!target) return notice(id, "No encuentro a ese usuario.");
      return kick(target.id, reason, false, c.nick);
    case "banear": case "ban":
      if (!target) return notice(id, "No encuentro a ese usuario.");
      return kick(target.id, reason, true, c.nick);
    case "desbanear-todo":
      bans.clear(); return notice(id, "Se levantaron todos los baneos.", "mod");
    case "fijar":
      pinned = arg.slice(0, 300); io.emit("pinned", pinned); return;
    case "desfijar":
      pinned = ""; io.emit("pinned", ""); return;
    case "anuncio":
      if (!arg) return;
      return io.emit("announce", { text: arg.slice(0, 400), ts: now() });
    case "lento":
      slowMode = Math.min(120, Math.max(0, parseInt(arg) || 0));
      return botSay(slowMode ? `🐢 Modo lento activado: un mensaje cada ${slowMode} s.` : "🐇 Modo lento desactivado.");
    case "limpiar":
      io.emit("clear"); return botSay("🧹 Un moderador limpió la sala.");
    case "filtro": {
      if (arg === "lista" || !arg) return notice(id, "Filtro: " + BAD_WORDS.join(", "), "mod");
      const w = norm(arg.slice(1)).trim();
      if (!w) return;
      if (arg[0] === "+" && !BAD_WORDS.includes(w)) BAD_WORDS.push(w);
      if (arg[0] === "-") BAD_WORDS = BAD_WORDS.filter((x) => x !== w);
      return notice(id, `Filtro actualizado (${BAD_WORDS.length} palabras).`, "mod");
    }
    case "reportes": {
      const lines = [...reports].map(([n, m]) => `${n}: ${m.size} reporte(s)`);
      return notice(id, lines.length ? "Reportes: " + lines.join(" · ") : "No hay reportes.", "mod");
    }
    default:
      return notice(id, "Comando desconocido. Probá /ayuda.");
  }
}

// ================== Conexiones ==================
io.on("connection", (socket) => {
  const ip = (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "").split(",")[0].trim();
  const banUntil = bans.get(ip);
  if (banUntil && banUntil > now()) {
    socket.emit("kicked", { reason: "Estás baneado/a temporalmente.", ban: true });
    return setTimeout(() => socket.disconnect(true), 300);
  }

  const c = {
    nick: "", status: "disponible", admin: false, ip, joinedAt: 0, strikes: [], mutes: 0, mutedUntil: 0,
    msgTimes: [], lastText: "", repeat: 0, lastMsgAt: 0, lastCrisis: 0, adminTries: 0, blocked: new Set(),
  };
  clients.set(socket.id, c);

  socket.on("join", (rawNick, cb) => {
    if (typeof cb !== "function") return;
    if (c.nick) return cb({ ok: true, nick: c.nick, users: userList(), pinned, slowMode });
    const nick = String(rawNick || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if (nick.length < 2) return cb({ ok: false, error: "El apodo tiene que tener al menos 2 caracteres." });
    if (!/^[\p{L}\p{N} _.\-]+$/u.test(nick)) return cb({ ok: false, error: "Usá solo letras, números, espacios, punto, guion o guion bajo." });
    if (RESERVED.includes(norm(nick)) || norm(nick).includes("guardian")) return cb({ ok: false, error: "Ese apodo no se puede usar." });
    if (censor(nick).hits) return cb({ ok: false, error: "Elegí un apodo sin insultos." });
    if (users.has(nick.toLowerCase())) return cb({ ok: false, error: "Ese apodo ya está en uso." });

    c.nick = nick; c.joinedAt = now();
    users.set(nick.toLowerCase(), socket.id);
    cb({ ok: true, nick, users: userList(), pinned, slowMode });
    socket.broadcast.emit("user-joined", nick);
    pushUsers();
  });

  socket.on("public-message", (raw) => {
    if (!c.nick) return;
    if (String(raw || "").trim().startsWith("/")) return runCommand(c, socket.id, String(raw).trim());
    const text = checkMessage(c, socket.id, raw);
    if (!text) return;
    const id = newId();
    remember(id, { chat: "general", from: c.nick });
    io.emit("public-message", { id, from: c.nick, admin: c.admin, text, ts: now() });
  });

  socket.on("private-message", ({ to, text: raw } = {}, cb) => {
    if (!c.nick || typeof cb !== "function") return;
    if (String(raw || "").trim().startsWith("/")) { runCommand(c, socket.id, String(raw).trim()); return cb({ ok: false, silent: true }); }
    const target = byNick(to);
    if (!target) return cb({ ok: false, error: "Ese usuario se desconectó." });
    if (target.c.blocked.has(c.nick.toLowerCase())) return cb({ ok: false, error: "No podés enviarle mensajes a esta persona." });
    const text = checkMessage(c, socket.id, raw);
    if (!text) return cb({ ok: false, silent: true });
    const id = newId();
    remember(id, { chat: "private", from: c.nick, to: target.c.nick });
    const msg = { id, from: c.nick, to: target.c.nick, admin: c.admin, text, ts: now() };
    io.to(target.id).emit("private-message", msg);
    cb({ ok: true, msg });
  });

  socket.on("typing", ({ to, on } = {}) => {
    if (!c.nick || c.mutedUntil > now()) return;
    if (!to) return socket.broadcast.emit("typing", { from: c.nick, chat: "__general__", on: !!on });
    const target = byNick(to);
    if (target && !target.c.blocked.has(c.nick.toLowerCase())) io.to(target.id).emit("typing", { from: c.nick, chat: c.nick, on: !!on });
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
    const set = (m.reactions[emoji] ||= new Set());
    set.has(c.nick) ? set.delete(c.nick) : set.add(c.nick);
    if (!set.size) delete m.reactions[emoji];
    const payload = { id, reactions: Object.fromEntries(Object.entries(m.reactions).map(([e, s]) => [e, [...s]])) };
    if (m.chat === "general") io.emit("reactions", payload);
    else [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("reactions", payload); });
  });

  socket.on("delete-message", (id) => {
    const m = messages.get(id);
    if (!m || !c.nick) return;
    if (m.from !== c.nick && !(c.admin && m.chat === "general")) return;
    messages.delete(id);
    if (m.chat === "general") io.emit("deleted", { id, byMod: m.from !== c.nick });
    else [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("deleted", { id }); });
  });

  socket.on("block", ({ target, on } = {}) => {
    const n = String(target || "").toLowerCase();
    if (!n) return;
    on ? c.blocked.add(n) : c.blocked.delete(n);
  });

  socket.on("report", ({ target, reason } = {}, cb) => {
    const t = byNick(target);
    if (!c.nick || !t || t.id === socket.id) return cb && cb({ ok: false });
    const key = t.c.nick.toLowerCase();
    const m = reports.get(key) || new Map();
    m.set(c.nick.toLowerCase(), now());
    for (const [k, ts] of m) if (now() - ts > 15 * 60000) m.delete(k);
    reports.set(key, m);
    cb && cb({ ok: true });
    notifyAdmins(`${c.nick} reportó a ${t.c.nick}: ${String(reason || "sin motivo").slice(0, 200)}`);
    if (m.size >= 3 && !t.c.admin && t.c.mutedUntil < now()) {
      m.clear();
      mute(t.c, t.id, 10, "Varios usuarios lo/la reportaron");
    }
  });

  socket.on("disconnect", () => {
    clients.delete(socket.id);
    if (!c.nick) return;
    users.delete(c.nick.toLowerCase());
    io.emit("user-left", c.nick);
    pushUsers();
  });
});

// Mantener despierto en Render (plan gratis)
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL && typeof fetch === "function") {
  setInterval(() => fetch(SELF_URL + "/ping").catch(() => {}), 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Gente Rota en http://localhost:${PORT}`));
