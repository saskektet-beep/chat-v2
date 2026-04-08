const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// Настройка путей
const publicPath = path.join(__dirname, "public");
app.use(express.static(publicPath));

// Маршруты для страниц
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(publicPath, 'admin.html'));
});

// Логика чата
let queue = [], reports = [], roomsHistory = new Map();
const ADMIN_PASSWORD = "Cfifcfif"; 

let bannedIPs = new Set();
if (fs.existsSync("bans.json")) {
    try {
        const data = fs.readFileSync("bans.json");
        bannedIPs = new Set(JSON.parse(data));
    } catch (e) { console.log("Ошибка чтения bans.json"); }
}

const saveBans = () => fs.writeFileSync("bans.json", JSON.stringify([...bannedIPs]));

const escapeHTML = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
};

function terminateChat(socket) {
    if (socket.room) {
        io.to(socket.room).emit("chatEnd");
        roomsHistory.delete(socket.room);
        socket.room = null;
    }
}

io.on("connection", (socket) => {
    const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (bannedIPs.has(userIP)) { socket.emit("banned_user"); socket.disconnect(); return; }
    
    io.emit("updateOnline", io.engine.clientsCount);

    socket.on("startSearch", (data) => {
        terminateChat(socket);
        queue = queue.filter(s => s.id !== socket.id);
        socket.permanentId = data.permanentId || "unknown";
        socket.username = escapeHTML(data.nickname) || "Аноним";
        socket.myGender = data.myGender || 'ALL';
        socket.myAge = data.myAge || 'ALL';
        socket.searchGender = data.searchGender || 'ALL';
        socket.searchAge = data.searchAge || 'ALL';

        const pIndex = queue.findIndex(p => {
            const gOk = (socket.searchGender === 'ALL' || socket.searchGender === p.myGender) && (p.searchGender === 'ALL' || p.searchGender === socket.myGender);
            const aOk = (socket.searchAge === 'ALL' || socket.searchAge === p.myAge) && (p.searchAge === 'ALL' || p.searchAge === socket.myAge);
            return gOk && aOk;
        });

        if (pIndex !== -1) {
            const partner = queue.splice(pIndex, 1)[0];
            const room = `room_${socket.id}_${partner.id}`;
            socket.join(room); partner.join(room);
            socket.room = room; partner.room = room;
            roomsHistory.set(room, []);
            socket.emit("chatStart", { partnerNick: partner.username });
            partner.emit("chatStart", { partnerNick: socket.username });
        } else {
            queue.push(socket);
            socket.emit("waiting");
        }
    });

    socket.on("message", (msg) => {
        if (socket.room && msg?.trim()) {
            const d = { id: socket.permanentId, nick: socket.username, text: escapeHTML(msg).substring(0, 1000), time: new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'}) };
            if(roomsHistory.has(socket.room)) roomsHistory.get(socket.room).push({...d, ip: userIP});
            io.to(socket.room).emit("message", d);
        }
    });

    socket.on("sendReport", () => {
        if (socket.room && roomsHistory.has(socket.room)) {
            reports.push({ id: Date.now(), reporterNick: socket.username, targetIP: userIP, time: new Date().toLocaleString(), chatLog: JSON.parse(JSON.stringify(roomsHistory.get(socket.room))) });
            io.emit("admin_update", { reports, banned: [...bannedIPs] });
        }
    });

    socket.on("admin_login", (p) => { if(p === ADMIN_PASSWORD) { socket.isAdmin = true; socket.emit("admin_access", { reports, banned: [...bannedIPs] }); } });
    
    socket.on("admin_ban_target", (ip) => {
        if (!socket.isAdmin) return;
        bannedIPs.add(ip); saveBans();
        io.sockets.sockets.forEach(s => { 
            const sIP = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
            if(sIP === ip){ s.emit("banned_user"); s.disconnect(); }
        });
        io.emit("admin_update", { reports, banned: [...bannedIPs] });
    });

    socket.on("admin_unban", (ip) => {
        if (!socket.isAdmin) return;
        bannedIPs.delete(ip); saveBans();
        io.emit("admin_update", { reports, banned: [...bannedIPs] });
    });

    socket.on("admin_close_report", (id) => {
        if (!socket.isAdmin) return;
        reports = reports.filter(r => r.id !== id);
        io.emit("admin_update", { reports, banned: [...bannedIPs] });
    });

    socket.on("endChat", () => terminateChat(socket));
    socket.on("disconnect", () => { terminateChat(socket); queue = queue.filter(u => u.id !== socket.id); io.emit("updateOnline", io.engine.clientsCount); });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
