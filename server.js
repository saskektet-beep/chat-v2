const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs"); // Для сохранения банов
const crypto = require("crypto");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8, cors: { origin: "*" } });

// Глобальный порт
const PORT = process.env.PORT || 3000;

// 1. ПУТИ (сохранил как в твоем старом сайте)
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
});
app.use(express.static(__dirname));

// 2. ДАННЫЕ
let queue = [], reports = [], roomsHistory = new Map();
const ADMIN_PASSWORD = "Cfifcfif"; 

// 3. ЗАГРУЗКА БАНОВ ИЗ ФАЙЛА
let bannedIPs = new Set();
if (fs.existsSync("bans.json")) {
    try {
        bannedIPs = new Set(JSON.parse(fs.readFileSync("bans.json")));
    } catch (e) { console.log("Ошибка чтения bans.json"); }
}
const saveBans = () => fs.writeFileSync("bans.json", JSON.stringify([...bannedIPs]));

// 4. ЗАЩИТА ОТ XSS (исправленная строка 27)
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
    const userIP = socket.handshake.address;
    
    // Проверка бана
    if (bannedIPs.has(userIP)) { 
        socket.emit("banned_user"); 
        socket.disconnect(); 
        return; 
    }
    
    io.emit("updateOnline", io.engine.clientsCount);

    socket.on("startSearch", (data) => {
        terminateChat(socket);
        queue = queue.filter(s => s.id !== socket.id);

        // Привязываем вечный ID к сокету
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
            
            socket.join(room);
            partner.join(room);
            socket.room = room;
            partner.room = room;

            roomsHistory.set(room, []);

            // Отправляем ники правильно
            socket.emit("chatStart", { partnerNick: partner.username });
            partner.emit("chatStart", { partnerNick: socket.username });
        } else {
            queue.push(socket);
            socket.emit("waiting");
        }
    });

    socket.on("message", (msg) => {
        if (socket.room && msg?.trim()) {
            const d = { 
                id: socket.permanentId, 
                nick: socket.username, 
                ip: userIP, 
                text: escapeHTML(msg).substring(0, 1000), 
                time: new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'}) 
            };
            if(roomsHistory.has(socket.room)) roomsHistory.get(socket.room).push(d);
            io.to(socket.room).emit("message", d);
        }
    });

    socket.on("sendReport", () => {
        if (socket.room && roomsHistory.has(socket.room)) {
            reports.push({ 
                id: Date.now(), 
                reporterNick: socket.username, 
                reporterId: socket.permanentId, 
                targetIP: userIP, 
                time: new Date().toLocaleString(), 
                chatLog: JSON.parse(JSON.stringify(roomsHistory.get(socket.room))) 
            });
            io.emit("admin_update", { reports, banned: [...bannedIPs] });
        }
    });

    socket.on("admin_login", (p) => { 
        if(p === ADMIN_PASSWORD) {
            socket.isAdmin = true;
            socket.emit("admin_access", { reports, banned: [...bannedIPs] }); 
        }
    });

    socket.on("admin_ban_target", (ip) => {
        if (!socket.isAdmin) return;
        bannedIPs.add(ip);
        saveBans();
        io.sockets.sockets.forEach(s => { if(s.handshake.address === ip){ s.emit("banned_user"); s.disconnect(); }});
        io.emit("admin_update", { reports, banned: [...bannedIPs] });
    });

    socket.on("admin_unban", (ip) => {
        if (!socket.isAdmin) return;
        bannedIPs.delete(ip);
        saveBans();
        io.emit("admin_update", { reports, banned: [...bannedIPs] });
    });

    socket.on("admin_close_report", (id) => {
        if (!socket.isAdmin) return;
        reports = reports.filter(r => r.id !== id);
        io.emit("admin_update", { reports, banned: [...bannedIPs] });
    });
    
    socket.on("endChat", () => terminateChat(socket));
    socket.on("disconnect", () => { 
        terminateChat(socket); 
        queue = queue.filter(u => u.id !== socket.id); 
        io.emit("updateOnline", io.engine.clientsCount); 
    });
});

// ГЛОБАЛЬНЫЙ ЗАПУСК (0.0.0.0 для внешнего доступа)
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Сервер запущен глобально: порт ${PORT}`);
