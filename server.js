const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sirve la carpeta tanto si se llama "public" como "Public"
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "Public")));
app.get("/ping", (req, res) => res.send("ok"));

// apodo (en minúsculas) -> socket.id   |   socket.id -> apodo
const users = new Map();
const nicks = new Map();

const MAX_NICK = 20;
const MAX_MSG = 500;
const RESERVED = ["__general__", "sistema", "admin"];

const userList = () => [...nicks.values()].sort((a, b) => a.localeCompare(b));

io.on("connection", (socket) => {
  let lastMsgs = [];
  const rateLimited = () => {
    const now = Date.now();
    lastMsgs = lastMsgs.filter((t) => now - t < 5000);
    if (lastMsgs.length >= 8) return true;
    lastMsgs.push(now);
    return false;
  };
  const clean = (t) => String(t || "").trim().slice(0, MAX_MSG);

  socket.on("join", (rawNick, cb) => {
    if (typeof cb !== "function") return;
    const nick = String(rawNick || "").trim().replace(/\s+/g, " ").slice(0, MAX_NICK);
    if (nicks.has(socket.id)) return cb({ ok: true, nick: nicks.get(socket.id), users: userList() });
    if (!nick) return cb({ ok: false, error: "Poné un apodo." });
    if (RESERVED.includes(nick.toLowerCase())) return cb({ ok: false, error: "Ese apodo no se puede usar." });
    if (nicks.has(socket.id)) return cb({ ok: true, nick: nicks.get(socket.id), users: userList() });
    if (users.has(nick.toLowerCase())) return cb({ ok: false, error: "Ese apodo ya está en uso." });

    users.set(nick.toLowerCase(), socket.id);
    nicks.set(socket.id, nick);
    cb({ ok: true, nick, users: userList() });
    socket.broadcast.emit("user-joined", nick);
    io.emit("users", userList());
  });

  socket.on("public-message", (text) => {
    const nick = nicks.get(socket.id);
    if (!nick || rateLimited()) return;
    text = clean(text);
    if (!text) return;
    io.emit("public-message", { from: nick, text, ts: Date.now() });
  });

  socket.on("private-message", ({ to, text } = {}, cb) => {
    const nick = nicks.get(socket.id);
    if (!nick || rateLimited()) return;
    text = clean(text);
    if (!text) return;
    const targetId = users.get(String(to || "").toLowerCase());
    if (!targetId) return cb && cb({ ok: false, error: "Ese usuario se desconectó." });
    const msg = { from: nick, to: nicks.get(targetId), text, ts: Date.now() };
    io.to(targetId).emit("private-message", msg);
    cb && cb({ ok: true, msg });
  });

  // "Está escribiendo…"  (to = null para la sala general)
  socket.on("typing", ({ to, on } = {}) => {
    const nick = nicks.get(socket.id);
    if (!nick) return;
    if (!to) return socket.broadcast.emit("typing", { from: nick, chat: "__general__", on: !!on });
    const targetId = users.get(String(to).toLowerCase());
    if (targetId) io.to(targetId).emit("typing", { from: nick, chat: nick, on: !!on });
  });

  socket.on("disconnect", () => {
    const nick = nicks.get(socket.id);
    if (!nick) return;
    nicks.delete(socket.id);
    users.delete(nick.toLowerCase());
    io.emit("user-left", nick);
    io.emit("users", userList());
  });
});

// Mantener despierto en Render (plan gratis): se llama a sí mismo cada 10 min
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL && typeof fetch === "function") {
  setInterval(() => fetch(SELF_URL + "/ping").catch(() => {}), 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Gente Rota en http://localhost:${PORT}`));
