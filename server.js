const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const publicPath = path.resolve(__dirname, "public");
app.use(express.static(publicPath));

app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(publicPath, 'admin.html')));

let queue = [], reports = [], roomsHistory = new Map();
const ADMIN_PASSWORD = "Cfifcfif"; 

let bannedIPs = new Set();
let bannedIds = new Set();

if (fs.existsSync("bans.json")) {
    try {
        const data = JSON.parse(fs.readFileSync("bans.json"));
        bannedIPs = new Set(data.ips || []);
        bannedIds = new Set(data.ids || []);
    } catch (e) { console.log("Ошибка чтения bans.json"); }
}

const saveBans = () => fs.writeFileSync("bans.json", JSON.stringify({ ips: [...bannedIPs], ids: [...bannedIds] }));

const escapeHTML = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
};

// Функция завершения чата
function terminateChat(socket, informPartner = true) {
    if (socket.room) {
        if (informPartner) {
            socket.to(socket.room).emit("chatEnd");
        }
        socket.leave(socket.room);
        roomsHistory.delete(socket.room);
        socket.room = null;
    }
}

io.on("connection", (socket) => {
    const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    if (bannedIPs.has(userIP)) { socket.emit("banned_user"); socket.disconnect(true); return; }
    
    io.emit("updateOnline", io.engine.clientsCount);

    // Универсальная логика поиска
    const startSearchLogic = (s) => {
        if (bannedIds.has(s.permanentId)) {
            s.emit("banned_user");
            s.disconnect(true);
            return;
        }

        queue = queue.filter(q => q.id !== s.id);
        const pIndex = queue.findIndex(p => p.id !== s.id);

        if (pIndex !== -1) {
            const partner = queue.splice(pIndex, 1)[0];
            const room = `room_${s.id}_${partner.id}`;
            s.join(room); partner.join(room);
            s.room = room; partner.room = room;
            roomsHistory.set(room, []);
            s.emit("chatStart", { partnerNick: partner.username });
            partner.emit("chatStart", { partnerNick: s.username });
        } else {
            queue.push(s);
            s.emit("waiting");
        }
    };

    socket.on("startSearch", (data) => {
        terminateChat(socket, true);
        socket.permanentId = data.permanentId || "unknown";
        socket.username = escapeHTML(data.nickname) || "Аноним";
        startSearchLogic(socket);
    });

    socket.on("endChat", () => {
        const wasInChat = !!socket.room;
        terminateChat(socket, true);
        if (wasInChat) {
            startSearchLogic(socket); // Сразу ищем нового после нажатия "Следующий"
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
            reports.push({ 
                id: Date.now(), 
                reporterNick: socket.username, 
                targetIP: userIP, 
                targetId: socket.permanentId, 
                time: new Date().toLocaleString(), 
                chatLog: JSON.parse(JSON.stringify(roomsHistory.get(socket.room))) 
            });
            io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
        }
    });

    socket.on("admin_login", (p) => { if(p === ADMIN_PASSWORD) { socket.isAdmin = true; socket.emit("admin_access", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] }); } });
    
    socket.on("admin_ban_id", (targetId) => {
        if (!socket.isAdmin) return;
        bannedIds.add(targetId);
        saveBans();
        io.sockets.sockets.forEach(s => { if(s.permanentId === targetId) { s.emit("banned_user"); s.disconnect(true); }});
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("admin_ban_target", (ip) => {
        if (!socket.isAdmin) return;
        bannedIPs.add(ip);
        saveBans();
        io.sockets.sockets.forEach(s => { 
            const sIP = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
            if(sIP === ip){ s.emit("banned_user"); s.disconnect(true); }
        });
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("admin_unban_id", (id) => {
        if (!socket.isAdmin) return;
        bannedIds.delete(id); saveBans();
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("admin_unban", (ip) => {
        if (!socket.isAdmin) return;
        bannedIPs.delete(ip); saveBans();
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("admin_close_report", (id) => {
        if (!socket.isAdmin) return;
        reports = reports.filter(r => r.id !== id);
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("disconnect", () => { 
        terminateChat(socket, true);
        queue = queue.filter(u => u.id !== socket.id); 
        io.emit("updateOnline", io.engine.clientsCount); 
    });
});

server.listen(PORT, () => console.log(`Сервер: ${PORT}`));
