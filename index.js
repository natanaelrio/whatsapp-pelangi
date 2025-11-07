const express = require("express");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
require("dotenv").config(); // <-- penting: load .env sebelum pakai process.env
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();

// === MIDDLEWARE DASAR ===
app.use(express.json());
app.use(cors()); // <-- tambahkan ini untuk izinkan akses dari domain lain

// === KONFIGURASI TOKEN AUTENTIKASI ===
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PORT = process.env.PORT || 3008;

// === MIDDLEWARE AUTENTIKASI ===
app.use((req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Token wajib disertakan pada header Authorization." });
    }

    const token = authHeader.split(" ")[1];
    if (token !== AUTH_TOKEN) {
        return res.status(403).json({ error: "Token tidak valid atau tidak diizinkan." });
    }

    next();
});

// === KONFIGURASI SESSION ===
const sessionPath = path.join(__dirname, ".wwebjs_auth");
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
}

// === INISIALISASI CLIENT WHATSAPP ===
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "session-wa",
        dataPath: sessionPath,
    }),
    puppeteer: {
        headless: true,
        executablePath: "/usr/bin/chromium-browser", // path yang sesuai
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-infobars",
        ],
    },
});

// === EVENT HANDLER ===
client.on("qr", qr => {
    console.log("📱 Scan QR untuk login WhatsApp (pertama kali saja):");
    qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => console.log("🔐 Autentikasi berhasil, session tersimpan."));
client.on("ready", () => console.log("✅ WhatsApp siap digunakan tanpa scan ulang!"));
client.on("auth_failure", msg => console.error("❌ Autentikasi gagal:", msg));
client.on("disconnected", reason => console.warn("⚠️ WhatsApp terputus:", reason));

client.initialize();

// === API: KIRIM PESAN KE GRUP ===
app.post("/send-group", async (req, res) => {
    const { groupId, message } = req.body;

    if (!groupId || !message) {
        return res.status(400).json({ error: "Parameter 'groupId' dan 'message' wajib diisi." });
    }

    try {
        await client.sendMessage(groupId, message);
        res.json({ success: true, message: `Pesan berhasil dikirim ke grup ${groupId}` });
    } catch (error) {
        console.error("❌ Gagal kirim pesan ke grup:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// === API: AMBIL SEMUA GRUP ===
app.get("/groups", async (req, res) => {
    try {
        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({ id: chat.id._serialized, name: chat.name }));

        res.json(groups);
    } catch (error) {
        console.error("❌ Gagal ambil daftar grup:", error);
        res.status(500).json({ error: error.message });
    }
});

// === API: CARI GRUP BERDASARKAN NAMA ===
app.get("/find-group", async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: "Parameter 'name' wajib diisi." });

    try {
        const chats = await client.getChats();
        const found = chats
            .filter(chat => chat.isGroup && chat.name.toLowerCase().includes(name.toLowerCase()))
            .map(g => ({ id: g.id._serialized, name: g.name }));

        if (found.length === 0)
            return res.status(404).json({ error: `Grup dengan nama '${name}' tidak ditemukan.` });

        res.json(found);
    } catch (error) {
        console.error("❌ Gagal mencari grup:", error);
        res.status(500).json({ error: error.message });
    }
});

// === JALANKAN SERVER ===
app.listen(PORT, () => console.log(`🌐 Server berjalan di http://localhost:${PORT}`));