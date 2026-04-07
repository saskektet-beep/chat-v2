const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });
const PORT = process.env.PORT || 3000;

// Сначала путь для админки
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
});

// Потом статика
app.use(express.static(__dirname));

let queue = [], reports = [], bannedIPs = new Set(), roomsHistory = {};
const ADMIN_PASSWORD = "Cfifcfif"; 

function terminateChat(socket) {
    if (socket.room) {
        io.to(socket.room).emit("chatEnd");
        delete roomsHistory[socket.room];
        socket.room = null;
    }
}

io.on("connection", (socket) => {
    const userIP = socket.handshake.address;
    if (bannedIPs.has(userIP)) { socket.emit("banned_user"); socket.disconnect(); return; }
    io.emit("updateOnline", io.engine.clientsCount);

    socket.on("startSearch", (data) => {
        socket.username = data.nickname || "Аноним";
        socket.myGender = data.myGender; socket.myAge = data.myAge;
        socket.searchGender = data.searchGender; socket.searchAge = data.searchAge;

        const partnerIndex = queue.findIndex(p => {
            const gOk = (socket.searchGender === 'ALL' || socket.searchGender === p.myGender) && (p.searchGender === 'ALL' || p.searchGender === socket.myGender);
            const aOk = (socket.searchAge === 'ALL' || socket.searchAge === p.myAge) && (p.searchAge === 'ALL' || p.searchAge === socket.myAge);
            return gOk && aOk;
        });

        if (partnerIndex !== -1) {
            const partner = queue.splice(partnerIndex, 1)[0];
            const room = `room_${socket.id}_${partner.id}`;
            socket.join(room); partner.join(room);
            socket.room = room; partner.room = room;
            roomsHistory[room] = [];
            io.to(room).emit("chatStart", { myNick: socket.username, partnerNick: partner.username });
        } else { queue.push(socket); socket.emit("waiting"); }
    });

    socket.on("message", (msg) => {
        if (socket.room) {
            const d = { id: socket.id, nick: socket.username, ip: userIP, text: msg, time: new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'}) };
            if(roomsHistory[socket.room]) roomsHistory[socket.room].push(d);
            io.to(socket.room).emit("message", d);
        }
    });

    socket.on("audioMessage", (audio) => {
        if (socket.room) {
            const d = { id: socket.id, nick: socket.username, ip: userIP, audio: audio, time: new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'}) };
            if(roomsHistory[socket.room]) roomsHistory[socket.room].push(d);
            io.to(socket.room).emit("audioMessage", d);
        }
    });

    socket.on("sendReport", () => {
        if (socket.room) {
            reports.push({ id: Date.now(), reporterNick: socket.username, time: new Date().toLocaleString(), chatLog: [...(roomsHistory[socket.room] || [])] });
            io.emit("admin_update", { reports, banned: Array.from(bannedIPs) });
        }
    });

    socket.on("admin_login", (p) => { if(p === ADMIN_PASSWORD) socket.emit("admin_access", { reports, banned: Array.from(bannedIPs) }); });
    socket.on("admin_ban_target", (ip) => {
        bannedIPs.add(ip);
        io.sockets.sockets.forEach(s => { if(s.handshake.address === ip){ s.emit("banned_user"); s.disconnect(); }});
        io.emit("admin_update", { reports, banned: Array.from(bannedIPs) });
    });
    socket.on("admin_unban", (ip) => { bannedIPs.delete(ip); io.emit("admin_update", { reports, banned: Array.from(bannedIPs) }); });
    socket.on("admin_close_report", (id) => { reports = reports.filter(r => r.id !== id); io.emit("admin_update", { reports, banned: Array.from(bannedIPs) }); });
    
    socket.on("endChat", () => terminateChat(socket));
    socket.on("disconnect", () => { terminateChat(socket); queue = queue.filter(u => u.id !== socket.id); io.emit("updateOnline", io.engine.clientsCount); });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
