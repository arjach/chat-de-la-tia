const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.set("trust proxy", true);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e6 }); // permite fotos de hasta ~2,5 MB

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
app.get("/config", (req, res) => res.json({ giphyKey: process.env.GIPHY_API_KEY || "", ai: !!process.env.GEMINI_API_KEY, iceServers: ICE_SERVERS }));

// ================== Configuración ==================
const BOT = "Fastidio";
const CRUPIER = "Crupier";
const ROOMS = ["general", "juegos", "voz", "confesiones", "mods"]; // "mods" = sala privada de moderadores · "confesiones" = anónima
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
const userList = (viewer) =>
  [...clients.values()].filter((c) => c.nick && !(viewer && blockedPair(viewer, c)))
    .map((c) => ({ nick: c.nick, status: c.status, admin: c.admin, role: role(c), champ: isChamp(c.nick), av: c.avatar ? c.avVer : 0, bio: c.bio || "" }))
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

function remember(id, data) {
  messages.set(id, { ...data, text: String(data.text || "").slice(0, 160), reactions: {} });
  if (messages.size > 3000) messages.delete(messages.keys().next().value);
}

// ---------- Mensajes del bot ----------
function botSay(text, room = "general", name = BOT) {
  const id = newId();
  remember(id, { chat: room, from: name, text });
  io.emit("public-message", { id, room, from: name, bot: true, text, ts: now() });
}
const gameSay = (text) => botSay(text, "juegos", CRUPIER);
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
function mute(c, id, minutes, reason, by = BOT) {
  c.mutedUntil = now() + minutes * 60000;
  voiceLeave(id);
  c.mutes++;
  notice(id, `🔇 Fuiste silenciado/a por ${minutes} min. Motivo: ${reason}`, "warn");
  botSay(`🔇 ${c.nick} fue silenciado/a ${minutes} min${by !== BOT ? " por un moderador" : ""}. Motivo: ${reason}`);
}
function kick(id, reason, ban = false, by = BOT) {
  const c = clients.get(id);
  if (!c) return;
  if (ban) { bans.set(c.ip, now() + 24 * 3600000); dirty(); }
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
function checkMessage(c, id, raw, room = "general", allowEmpty = false) {
  let text = String(raw || "").trim().slice(0, MAX_MSG);
  if (!text && !allowEmpty) return null;
  const t = now();
  if (lockedRooms.has(room) && !c.admin) {
    notice(id, "🔒 Esta sala está cerrada por moderación. Solo pueden escribir los moderadores.", "warn");
    return null;
  }
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
    if (c.msgTimes.length >= (room === "juegos" ? 12 : 6)) { strike(c, id, 1, "Mandar mensajes muy rápido (flood)"); return null; }
    c.msgTimes.push(t);

    const key = norm(text) || "[media]" + t;
    c.repeat = key === c.lastText && room !== "juegos" ? c.repeat + 1 : 0;
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
    if (room !== "juegos") return notice(id, "🎮 Los juegos son en la sala Juegos.");
    return gameCommand(c, id, cmd, arg);
  }

  if (cmd === "ayuda") {
    let help = "Comandos: /ayuda · /reglas · /admin <clave> · /juegos (en la sala Juegos)";
    if (c.owner) help += "\nDueño 👑: /mod <apodo> (hacer moderador a alguien conectado) · /desmod <apodo> · /crearclave <nombre> (sin que esté conectado) · /quitarclave <nombre> · /mods (ver moderadores y claves) · /db (estado de la base de datos)";
    if (c.admin) help += "\n🛡️ Moderación (o usá el botón 🛡️ Panel):" +
      "\n• Usuarios: /info <apodo> · /advertir <apodo> [motivo] · /silenciar <apodo> [min] · /desilenciar <apodo> · /expulsar <apodo> [motivo] · /banear <apodo> [motivo] · /desbanear-todo" +
      "\n• Más: /apodo <apodo> <nuevo> (cambiar apodo) · /sinavatar <apodo> (quitar foto de perfil) · /sinfotos <apodo> · /confotos <apodo> · /purgar <apodo> (borra sus mensajes)" +
      "\n• Salas: /cerrar · /abrir (en la sala actual) · /lento <seg> · /limpiar · /fijar <texto> · /desfijar · /anuncio <texto>" +
      "\n• Listas: /silenciados · /reportes · /filtro +palabra | -palabra | lista" +
      "\n• Sala 🛡️ Moderación: chat privado solo para moderadores";
    return notice(id, help);
  }
  if (cmd === "admin") {
    if (c.adminTries >= 5) return notice(id, "Demasiados intentos. Recargá la página para probar de nuevo.");
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
  const MOD_ONLY = ["sinavatar", "db", "mod", "desmod", "mods", "crearclave", "quitarclave", "info", "advertir", "warn", "silenciar", "mute", "desilenciar", "unmute", "expulsar", "kick", "banear", "ban", "desbanear-todo", "fijar", "desfijar", "anuncio", "lento", "limpiar", "filtro", "reportes", "apodo", "sinfotos", "confotos", "purgar", "cerrar", "abrir", "silenciados"];
  if (!c.admin) return notice(id, MOD_ONLY.includes(cmd)
    ? `"/${cmd}" es un comando de moderación. Si sos el dueño o moderador, primero escribí /admin <tu clave> (tiene que aparecerte 👑 o 🛡️ al lado del nombre).`
    : `No conozco el comando "/${cmdRaw}". Probá /ayuda.`);

  const [targetNick, ...why] = arg.split(" ");
  const reason = why.join(" ") || "Decisión de moderación";
  const target = byNick(targetNick);

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
      notice(target.id, "🔊 Ya podés volver a escribir.");
      return notice(id, `${target.c.nick} ya puede escribir.`, "mod");
    case "expulsar": case "kick":
      if (!target) return notice(id, "No encuentro a ese usuario.");
      return kick(target.id, reason, false, c.nick);
    case "banear": case "ban":
      if (!target) return notice(id, "No encuentro a ese usuario.");
      return kick(target.id, reason, true, c.nick);
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
        if (m.chat === "general" || m.chat === "juegos") if (m.from.toLowerCase() === n) { messages.delete(mid); io.emit("deleted", { id: mid, byMod: true }); count++; }
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

// ---------- Responder mensajes ----------
function buildReply(replyTo, room, me, other) {
  const m = messages.get(String(replyTo || ""));
  if (!m) return undefined;
  if (room) { if (m.chat !== room) return undefined; }
  else if (m.chat !== "private" || ![m.from, m.to].includes(me) || ![m.from, m.to].includes(other)) return undefined;
  return { id: replyTo, from: m.chat === "confesiones" ? "Anónimo" : m.from, text: m.text.slice(0, 120) };
}

// ================== Juegos ==================
const GAME_CMDS = ["quienesia", "turing", "mentiroso", "impostor", "asesinato", "100rotos", "rotos", "juicio", "eliminatorio", "llaves", "vor", "verdadoreto", "dibujo", "torneo", "ia", "juegos", "dado", "moneda", "ppt", "bola", "trivia", "numero", "número", "ahorcado", "ranking", "rendirse"];
const points = new Map(); // apodo -> puntos
const addPoints = (nick, n) => { points.set(nick, (points.get(nick) || 0) + n); weekly.points.set(nick, (weekly.points.get(nick) || 0) + n); dirty(); };
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const plain = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]/g, "").replace(/\s+/g, " ").trim();
let game = null; // juego activo en la sala

const TRIVIA = [
  ["¿Cuál es la capital de Australia?", ["canberra"]],
  ["¿Cuántos jugadores tiene un equipo de fútbol en la cancha?", ["11", "once"]],
  ["¿Qué planeta es conocido como el planeta rojo?", ["marte"]],
  ["¿En qué año llegó el hombre a la Luna?", ["1969"]],
  ["¿Quién pintó la Mona Lisa?", ["leonardo", "da vinci", "leonardo da vinci"]],
  ["¿Cuántos lados tiene un hexágono?", ["6", "seis"]],
  ["¿Cuál es el océano más grande del mundo?", ["pacifico", "oceano pacifico"]],
  ["¿Cuál es el símbolo químico del oro?", ["au"]],
  ["¿Cuál es la capital de Canadá?", ["ottawa"]],
  ["¿Quién escribió \"Don Quijote de la Mancha\"?", ["cervantes", "miguel de cervantes"]],
  ["¿En qué año ganó Argentina su tercer Mundial?", ["2022"]],
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
  ["¿En qué año se declaró la independencia argentina?", ["1816"]],
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
];
const WORDS = ["murcielago", "computadora", "mate", "asado", "empanada", "bandoneon", "guitarra", "cordillera", "pinguino",
  "dulce de leche", "alfajor", "colectivo", "chocolate", "biblioteca", "elefante", "jirafa", "mariposa", "relampago", "tormenta",
  "medialuna", "heladera", "ventilador", "bicicleta", "astronauta", "telescopio", "dinosaurio", "laberinto", "pirata", "tesoro",
  "volcan", "galaxia", "paraguas", "caramelo", "pizza", "milanesa", "zapatilla", "teclado", "auriculares", "camiseta",
  "cancha", "arquero", "gambeta", "hinchada", "trueno", "invierno", "primavera", "dragon", "castillo", "fantasma"];

function endGame() { if (game?.timer) clearTimeout(game.timer); const g = game; game = null; if (g?.cleanup) g.cleanup(); }

// ---------- Trivia (con IA si hay GEMINI_API_KEY) ----------
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const TOPICS = ["historia argentina", "geografía del mundo", "ciencia", "fútbol", "música argentina", "cine", "series", "videojuegos", "animales",
  "comida", "literatura", "historia universal", "deportes", "tecnología", "cuerpo humano", "espacio y astronomía", "rock nacional", "mitología", "arte", "idiomas"];
const recentQs = [];
let triviaRound = null; // { left, total, temas: [], scores: Map }
const roundTema = () => triviaRound?.temas.length ? triviaRound.temas[(triviaRound.total - triviaRound.left) % triviaRound.temas.length] : "";

let aiLastError = "";
let aiWorkingModel = "";
// Prueba el modelo configurado y, si no existe, otros parecidos
const MODELS = [...new Set([GEMINI_MODEL, "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-flash-latest"])];
function explainGemini(status, body) {
  const b = String(body || "");
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(b)) return "la clave de Gemini no es válida (revisá que esté bien copiada en Render, sin espacios)";
  if (status === 403 && /referer|referrer|BLOCKED|restricted|android|ios/i.test(b)) return "la clave de Gemini tiene restricciones (solo funciona desde otra web/app). Creá una clave nueva sin restricciones";
  if (status === 403 && /SERVICE_DISABLED|has not been used|disabled/i.test(b)) return "la API de Gemini no está habilitada en ese proyecto de Google. Creá la clave desde aistudio.google.com";
  if (status === 403) return "Google rechazó la clave (403). Probá con una clave nueva de aistudio.google.com";
  if (status === 429) return "se alcanzó el límite gratis de Gemini por ahora. Probá en un rato";
  if (status === 404) return "el modelo de IA no está disponible";
  if (status >= 500) return "Gemini tuvo un error de su lado. Probá de nuevo";
  return `Gemini respondió un error ${status}`;
}
async function callGemini(model, prompt, json = true, temperature = 1) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { ...(json ? { responseMimeType: "application/json" } : {}), temperature } }),
    });
    if (!r.ok) { const body = await r.text(); console.error("Gemini", model, r.status, body.slice(0, 300)); return { status: r.status, body }; }
    return { data: await r.json() };
  } finally { clearTimeout(to); }
}
// Pide algo a la IA; devuelve el texto (o el objeto si json) o null
async function aiCall(prompt, json = true, temperature = 1) {
  if (!GEMINI_KEY || typeof fetch !== "function") { aiLastError = "la IA no está activada (falta GEMINI_API_KEY)"; return null; }
  const models = aiWorkingModel ? [aiWorkingModel, ...MODELS.filter((m) => m !== aiWorkingModel)] : MODELS;
  for (const model of models) {
    try {
      const res = await callGemini(model, prompt, json, temperature);
      if (res.status === 404) continue;
      if (res.status) { aiLastError = explainGemini(res.status, res.body); return null; }
      const raw = res.data?.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("") || "";
      aiWorkingModel = model; aiLastError = "";
      if (!json) return raw.trim();
      return JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
    } catch (e) { aiLastError = e.name === "AbortError" ? "la IA tardó demasiado" : "la IA respondió algo raro"; return null; }
  }
  return null;
}
async function aiQuestion(tema) {
  if (!GEMINI_KEY) { aiLastError = "la IA no está activada: falta GEMINI_API_KEY en Render (Environment)"; return null; }
  if (typeof fetch !== "function") { aiLastError = "la versión de Node del servidor es muy vieja"; return null; }
  const prompt = `Generá UNA pregunta de trivia en español rioplatense sobre el tema "${tema}". La pregunta TIENE que ser sobre ese tema. Dificultad media, apta para un chat de amigos adultos.
La respuesta tiene que ser corta (1 a 3 palabras o un número), indiscutible y fácil de verificar. Nada de preguntas de opinión ni con varias respuestas válidas.
No repitas estas preguntas: ${recentQs.slice(-15).join(" | ") || "(ninguna)"}
Devolvé SOLO un JSON así: {"pregunta":"...","respuesta":"...","aceptadas":["variantes válidas de la respuesta, sin tildes, en minúscula"],"dato":"un dato curioso breve sobre la respuesta"}`;
  const models = aiWorkingModel ? [aiWorkingModel, ...MODELS.filter((m) => m !== aiWorkingModel)] : MODELS;
  for (const model of models) {
    try {
      const res = await callGemini(model, prompt);
      if (res.status === 404) { aiLastError = explainGemini(404); continue; } // probar el siguiente modelo
      if (res.status) { aiLastError = explainGemini(res.status, res.body); return null; }
      const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const q = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim() || "{}");
      if (!q.pregunta || !q.respuesta) { aiLastError = "la IA respondió algo incompleto"; return null; }
      aiWorkingModel = model; aiLastError = "";
      const answers = [...new Set([q.respuesta, ...(Array.isArray(q.aceptadas) ? q.aceptadas : [])].map(plain).filter(Boolean))];
      return { q: String(q.pregunta).slice(0, 300), shown: String(q.respuesta).slice(0, 80), answers, dato: String(q.dato || "").slice(0, 250), ai: true };
    } catch (e) {
      console.error("Gemini error:", model, e.message);
      aiLastError = e.name === "AbortError" ? "Gemini tardó demasiado en responder" : "no se pudo conectar con Gemini (" + e.message + ")";
      return null;
    }
  }
  return null;
}
function bankQuestion() {
  const pool = TRIVIA.filter(([q]) => !recentQs.includes(q));
  const [q, answers] = pick(pool.length ? pool : TRIVIA);
  return { q, shown: answers[0], answers, dato: "", ai: false };
}
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function isCorrect(guess, answers) {
  return answers.some((ans) => {
    if (guess === ans) return true;
    if (/^\d+$/.test(ans)) return guess.split(" ").includes(ans);
    if (ans.length >= 4 && (" " + guess + " ").includes(" " + ans + " ")) return true;
    const tol = ans.length >= 9 ? 2 : ans.length >= 5 ? 1 : 0;
    return tol > 0 && lev(guess, ans) <= tol;
  });
}
async function startTrivia(tema) {
  game = { type: "cargando" };
  const t = tema || pick(TOPICS);
  const custom = triviaRound?.custom?.length ? triviaRound.custom.shift() : null;
  let q = custom ? { q: custom.q, shown: custom.a[0], answers: custom.a.map(plain).filter(Boolean), dato: "", ai: false, custom: true } : await aiQuestion(t);
  if (!q) {
    q = bankQuestion();
    if (tema) gameSay(`⚠️ No pude hacer una pregunta de "${tema}": ${aiLastError}. Va una general.`);
  }
  recentQs.push(q.q); if (recentQs.length > 40) recentQs.shift();
  const n = triviaRound ? `[${triviaRound.total - triviaRound.left + 1}/${triviaRound.total}] ` : "";
  const secs = triviaRound?.secs || 40;
  game = { type: "trivia", answers: q.answers, shown: q.shown, dato: q.dato, only: triviaRound?.duel ? [triviaRound.duel.a, triviaRound.duel.b] : null, excl: triviaRound?.creator || null,
    timer: setTimeout(() => finishTrivia(null), secs * 1000) };
  gameSay(`❓ ${triviaRound?.duel ? `⚔️ DUELO ${triviaRound.duel.a} vs ${triviaRound.duel.b} ` : "TRIVIA "}${n}${q.custom ? `✍️ de ${triviaRound.creator} ` : ""}${q.ai ? "🤖 " : ""}(${q.ai ? t + " · " : ""}${secs} s)\n${q.q}\n${triviaRound?.duel ? "Solo responden los dos del duelo." : q.custom ? `Escribí la respuesta en el chat (${triviaRound.creator} no juega: la sabe 😉).` : "Escribí la respuesta en el chat."}`);
}
function finishTrivia(winner) {
  const g = game; endGame();
  const extra = g.dato ? `\n💡 ${g.dato}` : "";
  if (winner) {
    addPoints(winner, 3);
    if (triviaRound) triviaRound.scores.set(winner, (triviaRound.scores.get(winner) || 0) + 1);
    if (triviaRound?.duel) triviaRound.duel.scores[winner] = (triviaRound.duel.scores[winner] || 0) + 1;
    gameSay(`✅ ¡${winner} acertó! Era: ${g.shown}. +3 pts (total: ${points.get(winner)})${extra}`);
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
function rankingText() {
  const top = [...points].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!top.length) return "🏆 Todavía nadie sumó puntos. ¡Arrancá con /trivia, /numero o /ahorcado!";
  return "🏆 Ranking:\n" + top.map(([n, p], i) => `${["🥇", "🥈", "🥉"][i] || (i + 1) + "."} ${n} — ${p} pt${p === 1 ? "" : "s"}`).join("\n");
}
const hangView = () => game.word.split("").map((ch) => ch === " " ? "  " : game.found.has(ch) ? ch.toUpperCase() : "_").join(" ");
const GALLOWS = ["😀", "😐", "😕", "😟", "😨", "😱", "💀"];

function gameCommand(c, id, cmd, arg) {
  switch (cmd) {
    case "ia": {
      if (!GEMINI_KEY) return gameSay("🤖 IA: ❌ desactivada. Falta cargar GEMINI_API_KEY en Render → Environment.");
      gameSay("🤖 Probando la IA…");
      return aiQuestion("cultura general").then((q) => gameSay(q
        ? `🤖 IA: ✅ funciona (modelo ${aiWorkingModel}). Probá /trivia química`
        : `🤖 IA: ❌ falla: ${aiLastError}.`));
    }
    case "juegos":
      return notice(id, "🎮 JUEGOS (o usá los botones de abajo)\n" +
        "🤖 /quienesia — ¿Quién es la IA? · 🃏 /mentiroso · 🫣 /impostor · 🔪 /asesinato [tema]\n" +
        "🎭 /vor — Verdad o reto\n" +
        "📊 /100rotos — 100 rotos dicen (pensá como la mayoría)\n" +
        "⚖️ /juicio Nombre cargo — Juicio popular en broma\n" +
        "🖍️ /dibujo [rondas] — Dibujá y adiviná\n" +
        "❓ /trivia [tema] — una pregunta\n" +
        "🏁 /trivia ronda 10 cine, música — varias seguidas\n" +
        "🔢 /numero · 🪢 /ahorcado\n" +
        "✊ /ppt piedra · 🎲 /dado · 🪙 /moneda · 🎱 /bola ¿pregunta?\n" +
        "⚔️ Duelos: tocá el nombre de alguien · 🏟️ /eliminatorio — torneo con llaves (/llaves para verlas)\n" +
        "🏆 /torneo · 📊 /ranking · 🏳️ /rendirse · 🤖 /ia\n" +
        "Las respuestas se escriben normal en el chat. ¡El primero que acierta suma!");
    case "dado": {
      const caras = Math.min(1000, Math.max(2, parseInt(arg) || 6));
      return gameSay(`🎲 ${c.nick} tiró un dado de ${caras} caras y salió… ${1 + Math.floor(Math.random() * caras)}`);
    }
    case "moneda":
      return gameSay(`🪙 ${c.nick} tiró una moneda: ¡${pick(["CARA", "SECA"])}!`);
    case "bola":
      if (!arg) return notice(id, "Escribí una pregunta: /bola ¿hoy es mi día?");
      return gameSay(`🎱 ${c.nick} preguntó: "${arg.slice(0, 120)}"\n→ ${pick(["Sí, sin dudas.", "Ni en pedo.", "Probablemente.", "Mmm… no cuentes con eso.", "Preguntá más tarde.", "Las señales dicen que sí.", "Muy dudoso.", "Obvio.", "Mejor no te digo ahora.", "Concentrate y preguntá de nuevo."])}`);
    case "ppt": {
      const ops = ["piedra", "papel", "tijera"], emo = { piedra: "🪨", papel: "📄", tijera: "✂️" };
      const yo = plain(arg);
      if (!ops.includes(yo)) return notice(id, "Usá: /ppt piedra · /ppt papel · /ppt tijera");
      const bot = pick(ops);
      const gana = (yo === "piedra" && bot === "tijera") || (yo === "papel" && bot === "piedra") || (yo === "tijera" && bot === "papel");
      if (gana) addPoints(c.nick, 1);
      return gameSay(`${emo[yo]} ${c.nick} sacó ${yo} · yo saqué ${bot} ${emo[bot]} → ${yo === bot ? "¡Empate! 🤝" : gana ? `¡Ganó ${c.nick}! +1 pt` : "¡Gané yo! 😎"}`);
    }
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
      return startVor(c.nick);
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
        if (g.type === "juicio") return gameSay(`🏳️ ${c.nick} suspendió el juicio. ¡Se levanta la sesión!`);
        if (g.type === "llaves") return gameSay(`🏳️ ${c.nick} canceló el torneo eliminatorio.`);
        if (g.type === "vor") return gameSay(`🏳️ ${c.nick} terminó Verdad o reto. ¡Gracias por jugar!`);
        if (g.type === "dibujo") return gameSay(`🏳️ ${c.nick} cortó el juego. La palabra era: ${g.word.toUpperCase()}`);
        return gameSay(`🏳️ ${c.nick} cortó el juego. ${g.type === "trivia" ? `La respuesta era: ${g.shown}` : g.type === "numero" ? `El número era ${g.n}` : `La palabra era: ${g.word.toUpperCase()}`}`); }
    case "trivia": case "numero": case "número": case "ahorcado":
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
      if (cmd === "ahorcado") {
        game = { type: "ahorcado", word: pick(WORDS), found: new Set(), wrong: [], timer: setTimeout(() => { const g = game; endGame(); gameSay(`⏰ Se terminó el tiempo. La palabra era ${g.word.toUpperCase()}`); }, 5 * 60000) };
        return gameSay(`🪢 AHORCADO\n${hangView()}\nEscribí una letra o arriesgá la palabra entera. Tienen 6 vidas.`);
      }
      game = { type: "numero", n: 1 + Math.floor(Math.random() * 100), tries: 0, timer: setTimeout(() => { const g = game; endGame(); gameSay(`⏰ Se terminó el tiempo. El número era ${g.n}`); }, 3 * 60000) };
      return gameSay("🔢 Pensé un número del 1 al 100. ¡Adivinen! Escriban números en el chat.");
  }
}

// Revisa cada mensaje de la sala Juegos por si es una respuesta
function gameGuess(nick, text) {
  if (!game) return;
  const t = plain(text);
  if (!t) return;
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
  if (game.type === "numero") {
    if (!/^\d{1,4}$/.test(t)) return;
    const g = +t; game.tries++;
    if (g === game.n) { const tries = game.tries; endGame(); addPoints(nick, 2); return gameSay(`🎯 ¡${nick} lo adivinó! Era ${g} (en ${tries} intento${tries === 1 ? "" : "s"}). +2 pts`); }
    return gameSay(`${g < game.n ? "⬆️ Más alto" : "⬇️ Más bajo"} que ${g}`);
  }
  if (game.type === "ahorcado") {
    if (game.excl === nick) return;
    const word = plain(game.word);
    if (t === word) { const w = game.word; endGame(); addPoints(nick, 3); return gameSay(`🎉 ¡${nick} adivinó la palabra: ${w.toUpperCase()}! +3 pts`); }
    if (!/^[a-zñ]$/.test(t)) return;
    if (game.found.has(t) || game.wrong.includes(t)) return gameSay(`La "${t.toUpperCase()}" ya se dijo.`);
    const lives = game.lives || 6, face = () => GALLOWS[Math.min(6, Math.round(game.wrong.length * 6 / lives))];
    if (word.includes(t)) {
      game.found.add(t);
      if (word.replace(/ /g, "").split("").every((ch) => game.found.has(ch))) { const w = game.word; endGame(); addPoints(nick, 2); return gameSay(`🎉 ¡Completaron la palabra: ${w.toUpperCase()}! ${nick} puso la última letra (+2 pts)`); }
      return gameSay(`✔️ ¡Está la ${t.toUpperCase()}!\n${hangView()}\n${face()} Vidas: ${lives - game.wrong.length}${game.wrong.length ? " · Erradas: " + game.wrong.join(" ").toUpperCase() : ""}`);
    }
    game.wrong.push(t);
    if (game.wrong.length >= lives) { const w = game.word; endGame(); return gameSay(`💀 ¡Ahorcados! La palabra era ${w.toUpperCase()}`); }
    return gameSay(`❌ No está la ${t.toUpperCase()}.\n${hangView()}\n${face()} Vidas: ${lives - game.wrong.length} · Erradas: ${game.wrong.join(" ").toUpperCase()}`);
  }
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
    io.emit("announce", { text: `🏆 ¡${top[0][0]} ganó el torneo de la semana con ${top[0][1]} puntos! Se lleva la copa 🏆 hasta el próximo lunes.`, ts: Date.now() });
    gameSay("🏁 Terminó el torneo semanal.\n" + top.slice(0, 5).map(([n, p], i) => `${["🥇", "🥈", "🥉"][i] || (i + 1) + "."} ${n} — ${p} pts`).join("\n") + "\n¡Arranca uno nuevo!");
  }
  weekly.start = weekStartOf(Date.now()); weekly.points = new Map();
  dirty(); pushUsers();
}, 60000);

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
function vorNames() { return [...game.players].join(", "); }
function startVor(starter) {
  game = { type: "vor", phase: "join", players: new Set([starter]), turns: 0, last: "", lastAsker: "", timers: [],
    cleanup() { this.timers.forEach(clearTimeout); } };
  gameSay(`🎭 VERDAD O RETO — ${starter} arrancó una partida.\n✋ Escriban "yo" para sumarse (25 s).\nEn cada turno, alguien del grupo inventa la verdad o el reto. Con respeto: si no querés hacer algo, escribís "paso" y listo.`);
  game.timers.push(setTimeout(() => {
    if (!game || game.type !== "vor") return;
    if (game.players.size < 2) { gameSay("🎭 Se necesitan al menos 2 para jugar. Partida cancelada."); return endGame(); }
    gameSay(`🎭 ¡Arrancamos! Juegan: ${vorNames()}. (Pueden sumarse en cualquier momento escribiendo "yo")`);
    vorNext();
  }, 25000));
}
function vorClear() { game.timers.forEach(clearTimeout); game.timers = []; }
function vorNext() {
  if (!game || game.type !== "vor") return;
  vorClear();
  for (const n of [...game.players]) if (!byNick(n)) game.players.delete(n);
  if (game.players.size < 2) { gameSay("🎭 Quedan menos de 2 jugadores. ¡Fin de Verdad o reto!"); return endGame(); }
  if (game.turns >= 30) { gameSay("🎭 ¡Fin de la partida de Verdad o reto! Gracias por jugar 🫶"); return endGame(); }
  game.turns++;
  const options = [...game.players].filter((n) => n !== game.last);
  game.current = pick(options); game.last = game.current; game.phase = "choose"; game.kind = ""; game.asker = "";
  const t = byNick(game.current); if (t) io.to(t.id).emit("vor-choose");
  gameSay(`🎭 Turno ${game.turns}: le toca a ${game.current}. ¿VERDAD 🗣️ o RETO 🔥? (escribí "verdad" o "reto")`);
  game.timers.push(setTimeout(() => vorPick(pick(["verdad", "reto"]), true), 45000));
}
function vorPick(kind, auto) {
  if (!game || game.type !== "vor" || game.phase !== "choose") return;
  vorClear();
  game.kind = kind; game.phase = "asking";
  const others = [...game.players].filter((n) => n !== game.current && byNick(n));
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
  gameSay(`${game.kind === "verdad" ? "🗣️ VERDAD" : "🔥 RETO"} de ${c.nick} para ${game.current}:\n«${text.trim().slice(0, 300)}»\n${game.current}, cuando termines escribí "listo" (o "paso" si no querés).`);
  game.timers.push(setTimeout(() => { if (game?.type === "vor" && game.phase === "doing") { gameSay("⏰ Se terminó el tiempo de este turno."); vorNext(); } }, 3 * 60000));
  return true;
}
function vorGuess(nick, t) {
  if (t === "yo" || t === "yo juego" || t === "me sumo") {
    if (!game.players.has(nick)) { game.players.add(nick); gameSay(`✋ ${nick} se sumó. Juegan: ${vorNames()}`); }
    return;
  }
  if (nick !== game.current) return;
  if (game.phase === "choose" && (t === "verdad" || t === "reto")) return vorPick(t);
  if (game.phase === "doing" && /^(listo|ya|hecho|termine)$/.test(t)) { gameSay(`👏 ¡Bien ${nick}!`); game.phase = "next"; return game.timers.push(setTimeout(vorNext, 2500)); }
  if (["doing", "choose", "asking", "asking-open"].includes(game.phase) && /^(paso|me planto)$/.test(t)) { vorClear(); gameSay(`🙅 ${nick} pasó. Sin drama 🫶`); game.phase = "next"; return game.timers.push(setTimeout(vorNext, 2000)); }
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
    io.emit("announce", { text: `🏆 ¡${champ} es el/la CAMPEÓN/A del torneo eliminatorio! +10 pts`, ts: now() });
    gameSay(bracketText() + `\n\n🏆 CAMPEÓN/A: ${champ} 🎉`);
    return endGame();
  }
  const next = [];
  for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i], b: winners[i + 1], winner: null });
  game.rounds.push(next);
  game.timers.push(setTimeout(playBracketRound, 4000));
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
    if (place < 3 && g.people.length >= 2) for (const n of g.people) { addPoints(n, pts[place]); game.scores.set(n, (game.scores.get(n) || 0) + pts[place]); }
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
  const p = { room: "juegos", author: CRUPIER, question: `¿${g.acusado} es culpable de «${g.cargo}»?`, options, votes: new Map(), endsAt, exclude: [g.acusado],
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
  remember(id, { chat: "juegos", from: CRUPIER, text: "⚖️ " + p.question, ts: now(), media: true });
  io.emit("public-message", { id, room: "juegos", from: CRUPIER, bot: true, text: p.question, poll: { options, counts: [0, 0], endsAt }, ts: now() });
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
const secretCard = (nick, title, text) => { const t = byNick(nick); if (t) io.to(t.id).emit("secret-card", { title, text }); };
// Votación con botones en Juegos (reutiliza las votaciones); al terminar llama a onEnd(counts, votes)
function gamePoll(question, options, secs, onEnd, exclude = []) {
  const id = newId(), endsAt = now() + secs * 1000, g = game;
  const p = { room: "juegos", author: CRUPIER, question, options, votes: new Map(), endsAt, exclude,
    onEnd(counts) { if (game === g) onEnd(counts, p.votes); } };
  p.timer = setTimeout(() => endPoll(id), secs * 1000);
  polls.set(id, p); g.pollId = id;
  remember(id, { chat: "juegos", from: CRUPIER, text: "🗳️ " + question, ts: now(), media: true });
  io.emit("public-message", { id, room: "juegos", from: CRUPIER, bot: true, text: question, poll: { options, counts: options.map(() => 0), endsAt }, ts: now() });
  const old = g.cleanup; g.cleanup = function () { old.call(this); const pp = polls.get(id); if (pp) { clearTimeout(pp.timer); polls.delete(id); } };
}
const topVoted = (counts) => { const max = Math.max(...counts); return max ? counts.map((c, i) => c === max ? i : -1).filter((i) => i >= 0) : []; };

// ================== 🤖 ¿Quién es la IA? ==================
const TURING_TOPICS = ["¿Cuál es la peor comida que probaste?", "¿Qué harías con un millón de dólares?", "¿Playa o montaña y por qué?", "Contá algo que te dio vergüenza esta semana",
  "¿Cuál fue tu primer celular?", "¿Qué serie estás mirando?", "¿Mate dulce o amargo?", "¿Qué superpoder inútil te gustaría tener?", "¿Cuál es tu plan ideal de domingo?", "¿Le tenés miedo a algo raro?"];
function startTuring(starter, mins = 3) {
  if (!GEMINI_KEY) return gameSay("🤖 Este juego necesita la IA activada (GEMINI_API_KEY en Render).");
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
  remember(id, { chat: "juegos", from: alias, text, ts: now() });
  for (const [sid, rc] of clients) if (rc.nick) io.to(sid).emit("public-message", { id, room: "juegos", from: alias, alias: true, text, ts: now(), ...(sid === mineSid ? { mine: true } : {}) });
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
      for (const [n, idx] of votes) if (idx === aiIdx && g.alias.has(n)) addPoints(n, 3);
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
    gameSay(res.length ? `🏁 Fin de El Mentiroso. Ganó ${res[0][0]} con ${res[0][1]} pts 🃏\n` + res.map(([n, p]) => `${n}: ${p}`).join(" · ") : "🏁 Fin de El Mentiroso. ¡Nadie sumó!");
    return endGame();
  }
  g.round++; g.phase = "cargando"; g.lies = new Map();
  let fact = null;
  if (GEMINI_KEY) {
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
      else for (const a of o.authors) if (a !== voter) { addPoints(a, 1); g.scores.set(a, (g.scores.get(a) || 0) + 1); }
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
    if (!pair && GEMINI_KEY) {
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
    if (GEMINI_KEY) {
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
    for (const [n, idx] of votes) if (opts[idx] === g.culprit && n !== g.culprit) addPoints(n, 2);
    if (!caught) addPoints(g.culprit, 5);
    gameSay(`${caught ? `🚔 ¡ATRAPADO! El asesino era ${g.culprit} (${g.roles.get(g.culprit)}). +2 para quienes lo votaron.` : `😈 ¡EL ASESINO ESCAPÓ! Era ${g.culprit} (${g.roles.get(g.culprit)}). +5 para el/la asesino/a.`}\n🗝️ Arma: ${g.m.arma}\n📜 ${g.m.final}`);
    endGame();
  });
}

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
        io.emit("announce", { text: `📅 ¡Empieza! ${e.title}${e.action?.type === "trivia" ? " — vengan a 🎮 Juegos" : ""}`, ts: t });
        if (e.action?.type === "trivia" && !game) {
          triviaRound = { left: e.action.count, total: e.action.count, temas: e.action.temas || [], scores: new Map() };
          gameSay(`🏁 Evento: ${e.title}. RONDA de ${e.action.count} preguntas${e.action.temas?.length ? " sobre " + e.action.temas.join(", ") : ""}. ¡Atentos!`);
          setTimeout(() => startTrivia(roundTema()), 3000);
        }
      }
      if (e.weekly) { while (e.ts <= t) e.ts += 7 * 24 * 3600000; e.warned = false; }
      else events = events.filter((x) => x !== e);
    }
  }
  if (changed) { dirty(); pushEvents(); }
}, 30000);

// ================== Conexiones ==================
io.on("connection", (socket) => {
  const ip = (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "").split(",")[0].trim();
  const banUntil = bans.get(ip);
  if (banUntil && banUntil > now()) {
    socket.emit("kicked", { reason: "Estás baneado/a temporalmente.", ban: true });
    return setTimeout(() => socket.disconnect(true), 300);
  }

  const c = {
    nick: "", status: "disponible", admin: false, owner: false, ip, joinedAt: 0, strikes: [], mutes: 0, mutedUntil: 0,
    msgTimes: [], lastText: "", repeat: 0, lastMsgAt: 0, lastMediaAt: 0, lastCrisis: 0, adminTries: 0, blocked: new Set(),
  };
  clients.set(socket.id, c);

  socket.on("join", (rawNick, cb) => {
    if (typeof cb !== "function") return;
    if (c.nick) return cb({ ok: true, nick: c.nick, users: userList(c), pinned, slowMode, locked: [...lockedRooms], events: publicEvents() });
    const nick = String(rawNick || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if (nick.length < 2) return cb({ ok: false, error: "El apodo tiene que tener al menos 2 caracteres." });
    if (!/^[\p{L}\p{N} _.\-]+$/u.test(nick)) return cb({ ok: false, error: "Usá solo letras, números, espacios, punto, guion o guion bajo." });
    if (RESERVED.includes(norm(nick)) || norm(nick).includes("fastidio")) return cb({ ok: false, error: "Ese apodo no se puede usar." });
    if (censor(nick).hits) return cb({ ok: false, error: "Elegí otro apodo." });
    if (users.has(nick.toLowerCase())) return cb({ ok: false, error: "Ese apodo ya está en uso." });

    c.nick = nick; c.joinedAt = now();
    users.set(nick.toLowerCase(), socket.id);
    cb({ ok: true, nick, users: userList(c), pinned, slowMode, locked: [...lockedRooms], events: publicEvents() });
    emitFrom(c, "user-joined", nick, true);
    pushUsers();
  });

  socket.on("public-message", (payload) => {
    if (!c.nick) return;
    const p = typeof payload === "string" ? { text: payload } : payload || {};
    const room = ROOMS.includes(p.room) ? p.room : "general";
    if (room === "mods" && !c.admin) return;
    const raw = String(p.text || "").trim();
    if (raw.startsWith("/") && !p.image && !p.gif && !p.audio) return runCommand(c, socket.id, raw, room);
    const hasMedia = !!(p.image || p.gif || p.audio);
    const text = checkMessage(c, socket.id, raw, room, hasMedia);
    if (text === null) return;
    const media = checkMedia(c, socket.id, p);
    if (!media) return;
    if (room === "juegos" && text && picIntercept(c, socket.id, text)) return;
    if (room === "juegos" && text && vorIntercept(c, socket.id, text)) return;
    if (room === "juegos" && text && rotosIntercept(c, socket.id, text)) return;
    if (room === "juegos" && text && (turingIntercept(c, socket.id, text) || fibIntercept(c, socket.id, text) || impIntercept(c, socket.id, text))) return;
    if (room === "juegos") recentPlayers.set(c.nick, now());
    const id = newId();
    const reply = buildReply(p.replyTo, room);
    remember(id, { chat: room, from: c.nick, text: text || mediaLabel(media), ts: now(), media: !!(media.image || media.gif || media.audio) });
    const out = { id, room, from: c.nick, admin: c.admin, role: role(c), text, ...media, reply, ts: now() };
    if (room === "mods") emitToMods("public-message", out);
    else if (room === "confesiones") {
      // Nadie ve el nombre; los moderadores sí (para poder moderar); el autor lo ve como propio
      const anon = { id, room, from: "Anónimo", anon: true, text, ...media, reply, ts: out.ts };
      for (const [sid, rc] of clients) {
        if (!rc.nick || blockedPair(rc, c)) continue;
        io.to(sid).emit("public-message", rc === c ? { ...anon, mine: true } : rc.admin ? { ...anon, realFrom: c.nick } : anon);
      }
    } else emitFrom(c, "public-message", out);
    if (room === "juegos" && text) gameGuess(c.nick, text);
  });

  socket.on("private-message", ({ to, text: raw, replyTo, image, gif, audio } = {}, cb) => {
    if (!c.nick || typeof cb !== "function") return;
    if (String(raw || "").trim().startsWith("/") && !image && !gif && !audio) { runCommand(c, socket.id, String(raw).trim()); return cb({ ok: false, silent: true }); }
    const target = byNick(to);
    if (!target) return cb({ ok: false, error: "Ese usuario se desconectó." });
    if (blockedPair(c, target.c)) return cb({ ok: false, error: c.blocked.has(target.c.nick.toLowerCase()) ? `Tenés bloqueado/a a ${target.c.nick}. Desbloqueá para escribirle.` : "No podés enviarle mensajes a esta persona." });
    const text = checkMessage(c, socket.id, raw, "private", !!(image || gif || audio));
    if (text === null) return cb({ ok: false, silent: true });
    const media = checkMedia(c, socket.id, { image, gif, audio });
    if (!media) return cb({ ok: false, silent: true });
    const id = newId();
    remember(id, { chat: "private", from: c.nick, to: target.c.nick, text: text || mediaLabel(media), ts: now(), media: !!(media.image || media.gif || media.audio) });
    const reply = buildReply(replyTo, null, c.nick, target.c.nick);
    const msg = { id, from: c.nick, to: target.c.nick, admin: c.admin, role: role(c), text, ...media, reply, ts: now() };
    io.to(target.id).emit("private-message", msg);
    cb({ ok: true, msg });
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
    else if (m.chat !== "private") io.emit("reactions", payload);
    else [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("reactions", payload); });
  });

  // ---- Decidí por mí ----
  socket.on("poll-create", ({ room, question, options, minutes } = {}, cb) => {
    if (!c.nick) return;
    room = ["general", "juegos", "voz", "confesiones"].includes(room) ? room : "general";
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
    if (p.exclude?.includes(c.nick)) return notice(socket.id, "No podés votar en tu propio juicio 😅");
    idx = parseInt(idx); if (!(idx >= 0 && idx < p.options.length)) return;
    p.votes.set(c.nick, idx);
    const counts = pollCounts(p);
    io.emit("poll-update", { id, counts });
  });

  // ---- Juicio: el acusado acepta o rechaza ----
  socket.on("juicio-answer", (accept) => juicioAnswer(c, !!accept));
  socket.on("juicio-start", ({ to, cargo, condena } = {}) => {
    if (!c.nick) return;
    if (game) return notice(socket.id, "Ya hay un juego en curso en 🎮 Juegos. Esperá a que termine.");
    startJuicio(c, socket.id, to, cargo, condena);
  });

  // ---- Juegos personalizados ----
  socket.on("game-custom", (o = {}, cb) => {
    const fail = (error) => cb && cb({ ok: false, error });
    if (!c.nick) return;
    if (c.mutedUntil > now() && !c.admin) return fail("Estás silenciado/a.");
    if (game) return fail("Ya hay un juego en curso. Esperá a que termine (o /rendirse).");
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
        triviaRound = { left: qs.length, total: qs.length, temas: [], scores: new Map(), custom: qs, creator: c.nick, secs: secs(o.secs, 15, 120, 40) };
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
      case "numero": {
        const max = Math.min(9999, Math.max(5, parseInt(o.max) || 100)), sec = secs(o.secs, 30, 600, 180);
        game = { type: "numero", n: 1 + Math.floor(Math.random() * max), tries: 0, timer: setTimeout(() => { const g = game; endGame(); gameSay(`⏰ Se terminó el tiempo. El número era ${g.n}`); }, sec * 1000) };
        gameSay(`🔢 Pensé un número del 1 al ${max}. ¡Adivinen! Tienen ${sec >= 60 ? Math.round(sec / 60) + " min" : sec + " s"}.`); break;
      }
      case "eliminatorio": startBracket(c.nick, { secs: o.secs, bestOf: o.bestOf }); break;
      case "vor": startVor(c.nick); break;
      case "turing": if (!GEMINI_KEY) return fail("Este juego necesita la IA activada."); startTuring(c.nick, Math.min(6, Math.max(2, parseInt(o.mins) || 3))); break;
      case "mentiroso": startMentiroso(c.nick, Math.min(8, Math.max(1, parseInt(o.rounds) || 3))); break;
      case "impostor": {
        const a = txt(o.word, 30), b = txt(o.fake, 30);
        if ((a || b) && (!a || !b || plain(a) === plain(b))) return fail("Poné las dos palabras (distintas) o dejalas vacías.");
        startImpostor(c.nick, a && b ? [a, b] : null); break;
      }
      case "asesinato": startAsesinato(c.nick, txt(o.tema, 60)); break;
      default: return fail("Juego desconocido.");
    }
    cb && cb({ ok: true });
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
      else { c.avatar = Buffer.from(m[2], "base64"); c.avatarType = m[1]; c.avVer = now(); }
    }
    pushUsers();
    cb && cb({ ok: true });
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
      if (game) return duelExpire(d, "Hay otro juego en curso en 🎮 Juegos. Prueben cuando termine.");
      d.state = "on";
      gameSay(`⚔️ ¡DUELO DE TRIVIA! ${d.a} vs ${d.b} — 5 preguntas, solo responden ellos dos. ¡Vengan a mirar!`);
      triviaRound = { left: 5, total: 5, temas: [], scores: new Map(), duel: { id: d.id, a: d.a, b: d.b, scores: d.scores } };
      [d.a, d.b].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("duel-go", { id: d.id, room: "juegos" }); });
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
    m.text = text.slice(0, 160);
    const payload = { id, text, edited: true };
    if (m.chat === "private") [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("edited", payload); });
    else if (m.chat === "mods") emitToMods("edited", payload);
    else io.emit("edited", payload);
  });

  socket.on("delete-message", (id) => {
    const m = messages.get(id);
    if (!m || !c.nick) return;
    if (m.from !== c.nick && !(c.admin && m.chat !== "private")) return;
    messages.delete(id);
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
    randomQueue = randomQueue.filter((x) => x !== socket.id);
    voiceLeave(socket.id);
    if (!c.nick) return;
    if (c.inCall || c.callWith) hangup(c.inCall || c.callWith);
    for (const d of [...duels.values()]) if (d.a === c.nick || d.b === c.nick) {
      if (d.tour) { gameSay(`🏟️ ${c.nick} se desconectó: pierde por abandono.`); finishDuel(d, d.a === c.nick ? d.b : d.a, c.nick); continue; }
      if (d.kind === "trivia" && d.state === "on" && triviaRound?.duel?.id === d.id) { triviaRound = null; endGame(); }
      gameSay(`⚔️ Duelo ${d.a} vs ${d.b} cancelado: ${c.nick} se desconectó.`); duelExpire(d);
    }
    if (game?.type === "impostor" && game.impostor === c.nick) { gameSay(`🫣 ${c.nick} se fue… ¡y era el impostor! Fin del juego.`); endGame(); }
    if (game?.type === "asesinato" && game.culprit === c.nick) { gameSay(`🔪 ${c.nick} huyó de la escena… ¡era el asesino! Fin del juego.`); endGame(); }
    if (game?.type === "juicio" && game.acusado === c.nick) { gameSay(`⚖️ ${c.nick} se fugó del tribunal 🏃 Juicio suspendido.`); endGame(); }
    if (game?.type === "dibujo" && game.drawer === c.nick) { gameSay(`🖍️ ${c.nick} se desconectó mientras dibujaba.`); endPicRound(null); }
    users.delete(c.nick.toLowerCase());
    emitFrom(c, "user-left", c.nick);
    pushUsers();
  });
});

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
    bans: [...bans].filter(([, until]) => until > t),
    points: [...points],
    pinned, slowMode, badWords: BAD_WORDS, locked: [...lockedRooms], events,
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
      (st.bans || []).forEach(([ip, until]) => { if (until > now()) bans.set(ip, until); });
      (st.points || []).forEach(([n, p]) => points.set(n, p));
      pinned = st.pinned || ""; slowMode = st.slowMode || 0;
      if (Array.isArray(st.badWords)) BAD_WORDS = st.badWords;
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
process.on("SIGTERM", async () => { if (saveTimer) clearTimeout(saveTimer); db.pending = true; await saveNow().catch(() => {}); process.exit(0); });

const PORT = process.env.PORT || 3000;
Promise.race([loadState(), new Promise((ok) => setTimeout(ok, 6000))]).finally(() =>
  server.listen(PORT, () => console.log(`Gente Rota en http://localhost:${PORT}`)));
