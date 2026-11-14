const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// apodo (en minúsculas) -> socket.id
const users = new Map();
// socket.id -> apodo
const nicks = new Map();

const MAX_NICK = 20;
const MAX_MSG = 500;

function userList() {
  return [...nicks.values()].sort((a, b) => a.localeCompare(b));
}

io.on("connection", (socket) => {
  let lastMsgs = []; // anti-spam simple

  const rateLimited = () => {
    const now = Date.now();
    lastMsgs = lastMsgs.filter((t) => now - t < 5000);
    if (lastMsgs.length >= 8) return true;
    lastMsgs.push(now);
    return false;
  };

  // Entrar con un apodo
  socket.on("join", (rawNick, cb) => {
    const nick = String(rawNick || "").trim().slice(0, MAX_NICK);
    if (!nick) return cb({ ok: false, error: "Poné un apodo." });
    if (users.has(nick.toLowerCase()))
      return cb({ ok: false, error: "Ese apodo ya está en uso." });

    users.set(nick.toLowerCase(), socket.id);
    nicks.set(socket.id, nick);

    cb({ ok: true, nick, users: userList() });
    socket.broadcast.emit("user-joined", nick);
    io.emit("users", userList());
  });

  // Mensaje a la sala general
  socket.on("public-message", (text) => {
    const nick = nicks.get(socket.id);
    if (!nick || rateLimited()) return;
    text = String(text || "").trim().slice(0, MAX_MSG);
    if (!text) return;
    io.emit("public-message", { from: nick, text, ts: Date.now() });
  });

  // Mensaje privado
  socket.on("private-message", ({ to, text } = {}, cb) => {
    const nick = nicks.get(socket.id);
    if (!nick || rateLimited()) return;
    text = String(text || "").trim().slice(0, MAX_MSG);
    const targetId = users.get(String(to || "").toLowerCase());
    if (!text) return;
    if (!targetId) return cb && cb({ ok: false, error: "Ese usuario se desconectó." });

    const msg = { from: nick, to: nicks.get(targetId), text, ts: Date.now() };
    io.to(targetId).emit("private-message", msg);
    cb && cb({ ok: true, msg });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat en http://localhost:${PORT}`));
