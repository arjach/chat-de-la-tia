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
// Config pública para el navegador (la clave de GIPHY es pública por diseño)
app.get("/config", (req, res) => res.json({ giphyKey: process.env.GIPHY_API_KEY || "", ai: !!process.env.GEMINI_API_KEY }));

// ================== Configuración ==================
const BOT = "Guardián";
const CRUPIER = "Crupier";
const ROOMS = ["general", "juegos"];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ""; // se configura en Render
const MAX_MSG = 500;
const STATUSES = ["disponible", "hablar", "escucho", "ausente", "nomolestar"];
const REACTIONS = ["❤️", "🫂", "👍", "😂", "😢", "🔥", "💛"];
const RESERVED = ["guardian", "crupier", "admin", "administrador", "moderador", "mod", "sistema", "bot", "__general__"];

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
const userList = () =>
  [...clients.values()].filter((c) => c.nick)
    .map((c) => ({ nick: c.nick, status: c.status, admin: c.admin }))
    .sort((a, b) => a.nick.localeCompare(b.nick));
const pushUsers = () => io.emit("users", userList());

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
function checkMessage(c, id, raw, room = "general", allowEmpty = false) {
  let text = String(raw || "").trim().slice(0, MAX_MSG);
  if (!text && !allowEmpty) return null;
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
  const [cmdRaw, ...rest] = text.slice(1).split(" ");
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(" ").trim();

  if (GAME_CMDS.includes(cmd)) {
    if (room !== "juegos") return notice(id, "🎮 Los juegos son en la sala Juegos.");
    return gameCommand(c, id, cmd, arg);
  }

  if (cmd === "ayuda") {
    let help = "Comandos: /ayuda · /reglas · /admin <clave> · /juegos (en la sala Juegos)";
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
      io.emit("clear", { room }); return botSay("🧹 Un moderador limpió la sala.", room);
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

// ---------- Fotos y GIFs ----------
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const GIF_RE = /^https:\/\/(media\d*|i)\.giphy\.com\/[\w\-./?=&%]+$/;
function checkMedia(c, id, p) {
  const media = {};
  if (p.image) {
    if (typeof p.image !== "string" || p.image.length > 3.6e6 || !IMG_RE.test(p.image)) { notice(id, "📷 La imagen no es válida o es muy pesada (máx. ~2,5 MB).", "warn"); return null; }
    media.image = p.image;
  } else if (p.gif) {
    if (typeof p.gif !== "string" || p.gif.length > 500 || !GIF_RE.test(p.gif)) { notice(id, "GIF no válido.", "warn"); return null; }
    media.gif = p.gif;
  } else return {};
  const t = now();
  if (!c.admin) {
    if (t - c.joinedAt < 60000) { notice(id, "📷 Podés mandar fotos y GIFs después de tu primer minuto en el chat.", "warn"); return null; }
    if (t - c.lastMediaAt < 8000) { notice(id, "📷 Esperá unos segundos antes de mandar otra foto o GIF.", "warn"); return null; }
  }
  c.lastMediaAt = t;
  return media;
}
const mediaLabel = (m) => m.image ? "📷 Foto" : m.gif ? "🎞️ GIF" : "";

// ---------- Responder mensajes ----------
function buildReply(replyTo, room, me, other) {
  const m = messages.get(String(replyTo || ""));
  if (!m) return undefined;
  if (room) { if (m.chat !== room) return undefined; }
  else if (m.chat !== "private" || ![m.from, m.to].includes(me) || ![m.from, m.to].includes(other)) return undefined;
  return { id: replyTo, from: m.from, text: m.text.slice(0, 120) };
}

// ================== Juegos ==================
const GAME_CMDS = ["juegos", "dado", "moneda", "ppt", "bola", "trivia", "numero", "número", "ahorcado", "ranking", "rendirse"];
const points = new Map(); // apodo -> puntos
const addPoints = (nick, n) => points.set(nick, (points.get(nick) || 0) + n);
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

function endGame() { if (game?.timer) clearTimeout(game.timer); game = null; }

// ---------- Trivia (con IA si hay GEMINI_API_KEY) ----------
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const TOPICS = ["historia argentina", "geografía del mundo", "ciencia", "fútbol", "música argentina", "cine", "series", "videojuegos", "animales",
  "comida", "literatura", "historia universal", "deportes", "tecnología", "cuerpo humano", "espacio y astronomía", "rock nacional", "mitología", "arte", "idiomas"];
const recentQs = [];
let triviaRound = null; // { left, total, tema, scores: Map }

async function aiQuestion(tema) {
  if (!GEMINI_KEY || typeof fetch !== "function") return null;
  const prompt = `Generá UNA pregunta de trivia en español rioplatense sobre: ${tema}. Dificultad media, apta para un chat de amigos adultos.
La respuesta tiene que ser corta (1 a 3 palabras o un número), indiscutible y fácil de verificar. Nada de preguntas de opinión ni con varias respuestas válidas.
No repitas estas preguntas: ${recentQs.slice(-15).join(" | ") || "(ninguna)"}
Devolvé SOLO un JSON así: {"pregunta":"...","respuesta":"...","aceptadas":["variantes válidas de la respuesta, sin tildes, en minúscula"],"dato":"un dato curioso breve sobre la respuesta"}`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 1 } }),
    });
    clearTimeout(to);
    if (!r.ok) { console.error("Gemini", r.status, (await r.text()).slice(0, 200)); return null; }
    const data = await r.json();
    const q = JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    if (!q.pregunta || !q.respuesta) return null;
    const answers = [...new Set([q.respuesta, ...(Array.isArray(q.aceptadas) ? q.aceptadas : [])].map(plain).filter(Boolean))];
    return { q: String(q.pregunta).slice(0, 300), shown: String(q.respuesta).slice(0, 80), answers, dato: String(q.dato || "").slice(0, 250), ai: true };
  } catch (e) { console.error("Gemini error:", e.message); return null; }
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
  const q = (await aiQuestion(t)) || bankQuestion();
  recentQs.push(q.q); if (recentQs.length > 40) recentQs.shift();
  const n = triviaRound ? `[${triviaRound.total - triviaRound.left + 1}/${triviaRound.total}] ` : "";
  game = { type: "trivia", answers: q.answers, shown: q.shown, dato: q.dato,
    timer: setTimeout(() => finishTrivia(null), 40000) };
  gameSay(`❓ TRIVIA ${n}${q.ai ? "🤖 " : ""}(${q.ai ? t + " · " : ""}40 s)\n${q.q}\nEscribí la respuesta en el chat.`);
}
function finishTrivia(winner) {
  const g = game; endGame();
  const extra = g.dato ? `\n💡 ${g.dato}` : "";
  if (winner) {
    addPoints(winner, 3);
    if (triviaRound) triviaRound.scores.set(winner, (triviaRound.scores.get(winner) || 0) + 1);
    gameSay(`✅ ¡${winner} acertó! Era: ${g.shown}. +3 pts (total: ${points.get(winner)})${extra}`);
  } else gameSay(`⏰ ¡Tiempo! Nadie acertó. Era: ${g.shown}${extra}`);
  if (triviaRound) {
    triviaRound.left--;
    if (triviaRound.left > 0) { const tema = triviaRound.tema; setTimeout(() => { if (!game && triviaRound) startTrivia(tema); }, 4000); }
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
    case "juegos":
      return notice(id, "🎮 Juegos: /trivia [tema] · /trivia ronda [tema] (5 preguntas) · /numero · /ahorcado · /ppt piedra|papel|tijera · /dado [caras] · /moneda · /bola <pregunta> · /ranking · /rendirse (corta el juego en curso)\nEn trivia, número y ahorcado respondés escribiendo normal en la sala. ¡El primero que acierta suma puntos!");
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
    case "rendirse":
      if (!game || game.type === "cargando") return notice(id, "No hay ningún juego en curso.");
      { const g = game; endGame(); triviaRound = null;
        return gameSay(`🏳️ ${c.nick} cortó el juego. ${g.type === "trivia" ? `La respuesta era: ${g.shown}` : g.type === "numero" ? `El número era ${g.n}` : `La palabra era: ${g.word.toUpperCase()}`}`); }
    case "trivia": case "numero": case "número": case "ahorcado":
      if (game) return notice(id, "Ya hay un juego en curso. Terminalo o escribí /rendirse.");
      if (cmd === "trivia") {
        let tema = arg.trim();
        if (/^ronda\b/i.test(tema)) {
          tema = tema.replace(/^ronda\s*/i, "");
          triviaRound = { left: 5, total: 5, tema, scores: new Map() };
          gameSay(`🏁 ${c.nick} arrancó una RONDA de 5 preguntas${tema ? " sobre " + tema : ""}. ¡Atentos!`);
        }
        if (tema && !GEMINI_KEY) notice(id, "ℹ️ Los temas personalizados necesitan la IA activada. Va una pregunta al azar.");
        return startTrivia(GEMINI_KEY ? tema.slice(0, 60) : "");
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
    if (isCorrect(t, game.answers)) finishTrivia(nick);
    return;
  }
  if (game.type === "numero") {
    if (!/^\d{1,3}$/.test(t)) return;
    const g = +t; game.tries++;
    if (g === game.n) { const tries = game.tries; endGame(); addPoints(nick, 2); return gameSay(`🎯 ¡${nick} lo adivinó! Era ${g} (en ${tries} intento${tries === 1 ? "" : "s"}). +2 pts`); }
    return gameSay(`${g < game.n ? "⬆️ Más alto" : "⬇️ Más bajo"} que ${g}`);
  }
  if (game.type === "ahorcado") {
    const word = plain(game.word);
    if (t === word) { const w = game.word; endGame(); addPoints(nick, 3); return gameSay(`🎉 ¡${nick} adivinó la palabra: ${w.toUpperCase()}! +3 pts`); }
    if (!/^[a-zñ]$/.test(t)) return;
    if (game.found.has(t) || game.wrong.includes(t)) return gameSay(`La "${t.toUpperCase()}" ya se dijo.`);
    if (word.includes(t)) {
      game.found.add(t);
      if (word.replace(/ /g, "").split("").every((ch) => game.found.has(ch))) { const w = game.word; endGame(); addPoints(nick, 2); return gameSay(`🎉 ¡Completaron la palabra: ${w.toUpperCase()}! ${nick} puso la última letra (+2 pts)`); }
      return gameSay(`✔️ ¡Está la ${t.toUpperCase()}!\n${hangView()}\n${GALLOWS[game.wrong.length]} Vidas: ${6 - game.wrong.length}${game.wrong.length ? " · Erradas: " + game.wrong.join(" ").toUpperCase() : ""}`);
    }
    game.wrong.push(t);
    if (game.wrong.length >= 6) { const w = game.word; endGame(); return gameSay(`💀 ¡Ahorcados! La palabra era ${w.toUpperCase()}`); }
    return gameSay(`❌ No está la ${t.toUpperCase()}.\n${hangView()}\n${GALLOWS[game.wrong.length]} Vidas: ${6 - game.wrong.length} · Erradas: ${game.wrong.join(" ").toUpperCase()}`);
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
    msgTimes: [], lastText: "", repeat: 0, lastMsgAt: 0, lastMediaAt: 0, lastCrisis: 0, adminTries: 0, blocked: new Set(),
  };
  clients.set(socket.id, c);

  socket.on("join", (rawNick, cb) => {
    if (typeof cb !== "function") return;
    if (c.nick) return cb({ ok: true, nick: c.nick, users: userList(), pinned, slowMode });
    const nick = String(rawNick || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if (nick.length < 2) return cb({ ok: false, error: "El apodo tiene que tener al menos 2 caracteres." });
    if (!/^[\p{L}\p{N} _.\-]+$/u.test(nick)) return cb({ ok: false, error: "Usá solo letras, números, espacios, punto, guion o guion bajo." });
    if (RESERVED.includes(norm(nick)) || norm(nick).includes("guardian")) return cb({ ok: false, error: "Ese apodo no se puede usar." });
    if (censor(nick).hits) return cb({ ok: false, error: "Elegí otro apodo." });
    if (users.has(nick.toLowerCase())) return cb({ ok: false, error: "Ese apodo ya está en uso." });

    c.nick = nick; c.joinedAt = now();
    users.set(nick.toLowerCase(), socket.id);
    cb({ ok: true, nick, users: userList(), pinned, slowMode });
    socket.broadcast.emit("user-joined", nick);
    pushUsers();
  });

  socket.on("public-message", (payload) => {
    if (!c.nick) return;
    const p = typeof payload === "string" ? { text: payload } : payload || {};
    const room = ROOMS.includes(p.room) ? p.room : "general";
    const raw = String(p.text || "").trim();
    if (raw.startsWith("/") && !p.image && !p.gif) return runCommand(c, socket.id, raw, room);
    const hasMedia = !!(p.image || p.gif);
    const text = checkMessage(c, socket.id, raw, room, hasMedia);
    if (text === null) return;
    const media = checkMedia(c, socket.id, p);
    if (!media) return;
    const id = newId();
    const reply = buildReply(p.replyTo, room);
    remember(id, { chat: room, from: c.nick, text: text || mediaLabel(media) });
    io.emit("public-message", { id, room, from: c.nick, admin: c.admin, text, ...media, reply, ts: now() });
    if (room === "juegos" && text) gameGuess(c.nick, text);
  });

  socket.on("private-message", ({ to, text: raw, replyTo, image, gif } = {}, cb) => {
    if (!c.nick || typeof cb !== "function") return;
    if (String(raw || "").trim().startsWith("/") && !image && !gif) { runCommand(c, socket.id, String(raw).trim()); return cb({ ok: false, silent: true }); }
    const target = byNick(to);
    if (!target) return cb({ ok: false, error: "Ese usuario se desconectó." });
    if (target.c.blocked.has(c.nick.toLowerCase())) return cb({ ok: false, error: "No podés enviarle mensajes a esta persona." });
    const text = checkMessage(c, socket.id, raw, "private", !!(image || gif));
    if (text === null) return cb({ ok: false, silent: true });
    const media = checkMedia(c, socket.id, { image, gif });
    if (!media) return cb({ ok: false, silent: true });
    const id = newId();
    remember(id, { chat: "private", from: c.nick, to: target.c.nick, text: text || mediaLabel(media) });
    const reply = buildReply(replyTo, null, c.nick, target.c.nick);
    const msg = { id, from: c.nick, to: target.c.nick, admin: c.admin, text, ...media, reply, ts: now() };
    io.to(target.id).emit("private-message", msg);
    cb({ ok: true, msg });
  });

  socket.on("typing", ({ to, room, on } = {}) => {
    if (!c.nick || c.mutedUntil > now()) return;
    if (!to) return socket.broadcast.emit("typing", { from: c.nick, chat: "#" + (ROOMS.includes(room) ? room : "general"), on: !!on });
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
    if (m.chat !== "private") io.emit("reactions", payload);
    else [m.from, m.to].forEach((n) => { const t = byNick(n); if (t) io.to(t.id).emit("reactions", payload); });
  });

  socket.on("delete-message", (id) => {
    const m = messages.get(id);
    if (!m || !c.nick) return;
    if (m.from !== c.nick && !(c.admin && m.chat !== "private")) return;
    messages.delete(id);
    if (m.chat !== "private") io.emit("deleted", { id, byMod: m.from !== c.nick });
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
