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

// Храним баны и по IP, и по ID
let bannedIPs = new Set();
let bannedIds = new Set();

// Загрузка банов
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

io.on("connection", (socket) => {
    const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // Сразу проверяем IP
    if (bannedIPs.has(userIP)) { socket.emit("banned_user"); socket.disconnect(true); return; }
    
    io.emit("updateOnline", io.engine.clientsCount);

    socket.on("startSearch", (data) => {
        // Проверяем ID устройства при попытке начать поиск
        if (bannedIds.has(data.permanentId)) {
            socket.emit("banned_user");
            socket.disconnect(true);
            return;
        }

        if (socket.room) { io.to(socket.room).emit("chatEnd"); roomsHistory.delete(socket.room); socket.room = null; }
        queue = queue.filter(s => s.id !== socket.id);
        
        socket.permanentId = data.permanentId || "unknown";
        socket.username = escapeHTML(data.nickname) || "Аноним";
        
        const pIndex = queue.findIndex(p => p.id !== socket.id);
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
            // В жалобу теперь попадает и IP, и ID того, на кого жалуются
            reports.push({ 
                id: Date.now(), 
                reporterNick: socket.username, 
                targetIP: userIP, 
                targetId: socket.permanentId, // Это ID того, кто отправил отчет (в реальном чате нужно брать ID оппонента)
                time: new Date().toLocaleString(), 
                chatLog: JSON.parse(JSON.stringify(roomsHistory.get(socket.room))) 
            });
            io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
        }
    });

    socket.on("admin_login", (p) => { if(p === ADMIN_PASSWORD) { socket.isAdmin = true; socket.emit("admin_access", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] }); } });
    
    // БАН ПО ID УСТРОЙСТВА
    socket.on("admin_ban_id", (targetId) => {
        if (!socket.isAdmin) return;
        bannedIds.add(targetId);
        saveBans();
        io.sockets.sockets.forEach(s => { if(s.permanentId === targetId) { s.emit("banned_user"); s.disconnect(true); }});
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("admin_unban_id", (id) => {
        if (!socket.isAdmin) return;
        bannedIds.delete(id); saveBans();
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("admin_close_report", (id) => {
        if (!socket.isAdmin) return;
        reports = reports.filter(r => r.id !== id);
        io.emit("admin_update", { reports, bannedIps: [...bannedIPs], bannedIds: [...bannedIds] });
    });

    socket.on("disconnect", () => { queue = queue.filter(u => u.id !== socket.id); io.emit("updateOnline", io.engine.clientsCount); });
});

server.listen(PORT, () => console.log(`Сервер: ${PORT}`));
