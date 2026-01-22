process.env.NODE_OPTIONS = "--no-warnings"

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from "@whiskeysockets/baileys"
import express from "express"
import qrcode from "qrcode-terminal"
import pino from "pino"
import cors from "cors"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"

dotenv.config()

// ================= FILTER LOG SESSION =================

const originalLog = console.log
console.log = (...args) => {
    if (
        typeof args[0] === "string" &&
        (
            args[0].includes("Closing session") ||
            args[0].includes("SessionEntry") ||
            args[0].includes("_chains")
        )
    ) return

    originalLog(...args)
}


// ============ FORCE CLEAN ALL NOISE LOG ============

const originalStdout = process.stdout.write.bind(process.stdout)
const originalStderr = process.stderr.write.bind(process.stderr)

const blockPatterns = [
    "Closing session",
    "SessionEntry",
    "_chains",
    "registrationId",
    "currentRatchet",
    "ephemeralKeyPair",
    "rootKey",
    "indexInfo",
    "pendingPreKey"
]

process.stdout.write = (chunk, encoding, callback) => {
    const text = chunk?.toString?.() || ""
    if (blockPatterns.some(p => text.includes(p))) return true
    return originalStdout(chunk, encoding, callback)
}

process.stderr.write = (chunk, encoding, callback) => {
    const text = chunk?.toString?.() || ""
    if (blockPatterns.some(p => text.includes(p))) return true
    return originalStderr(chunk, encoding, callback)
}

console.log = (...args) => {
    if (args.some(a => blockPatterns.some(p => String(a).includes(p)))) return
    originalStdout(args.join(" ") + "\n")
}

console.error = (...args) => {
    if (args.some(a => blockPatterns.some(p => String(a).includes(p)))) return
    originalStderr(args.join(" ") + "\n")
}


// ================= LOGGER =================

const log = (...args) => {
    const now = new Date()
    const time = now.toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour12: false
    })
    console.log(`[${time}]`, ...args)
}

// ================= APP INIT =================

const app = express()
app.use(express.json())
app.use(cors())

const PORT = process.env.PORT || 3008
const AUTH_TOKEN = process.env.AUTH_TOKEN || "123456"

// ================= AUTH MIDDLEWARE =================

app.use((req, res, next) => {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Token wajib disertakan" })
    }

    const token = authHeader.split(" ")[1]

    if (token !== AUTH_TOKEN) {
        return res.status(403).json({ error: "Token tidak valid" })
    }

    next()
})

// ================= SESSION =================

const sessionPath = path.join(process.cwd(), "session")
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true })
}

let sock

// ================= START WA =================

async function startWA() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: state,
        version,
        browser: ["WA API", "Chrome", "1.0"]
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            log("📱 QR tersedia, silakan scan")
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            log("✅ WhatsApp siap digunakan tanpa scan ulang!")
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            log("❌ Terputus, reconnect:", shouldReconnect)

            if (shouldReconnect) startWA()
        }
    })
}

startWA()

// ================= GLOBAL ERROR =================

process.on("unhandledRejection", err => {
    log("❌ UNHANDLED REJECTION:", err)
})

process.on("uncaughtException", err => {
    log("❌ UNCAUGHT EXCEPTION:", err)
})

// ================= UTIL =================

const normalizeNumber = (number) => {
    return number.replace(/\D/g, "") + "@s.whatsapp.net"
}

// ================= API =================

// SEND PERSONAL
app.post("/send-person", async (req, res) => {
    const { contactId, message } = req.body

    if (!contactId || !message) {
        return res.status(400).json({ error: "contactId & message wajib diisi" })
    }

    try {
        const jid = normalizeNumber(contactId)
        log(`📤 Kirim ke ${jid}: ${message}`)

        await sock.sendMessage(jid, { text: message })

        log(`✅ Terkirim ke ${jid}`)
        res.json({ success: true, message: "Pesan terkirim" })
    } catch (err) {
        log("❌ Gagal kirim personal:", err)
        res.status(500).json({ success: false, error: err.message })
    }
})

// SEND GROUP
app.post("/send-group", async (req, res) => {
    const { groupId, message } = req.body

    if (!groupId || !message) {
        return res.status(400).json({ error: "groupId & message wajib diisi" })
    }

    try {
        log(`📤 Kirim ke grup ${groupId}: ${message}`)

        await sock.sendMessage(groupId, { text: message })

        log(`✅ Terkirim ke grup ${groupId}`)
        res.json({ success: true, message: "Pesan grup terkirim" })
    } catch (err) {
        log("❌ Gagal kirim grup:", err)
        res.status(500).json({ success: false, error: err.message })
    }
})

// GET GROUP LIST
app.get("/groups", async (req, res) => {
    try {
        const groups = await sock.groupFetchAllParticipating()

        const list = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject
        }))

        log(`📋 Ambil semua grup: ${list.length}`)
        res.json(list)
    } catch (err) {
        log("❌ Gagal ambil grup:", err)
        res.status(500).json({ error: err.message })
    }
})

// FIND GROUP
app.get("/find-group", async (req, res) => {
    const { name } = req.query
    if (!name) return res.status(400).json({ error: "name wajib diisi" })

    try {
        const groups = await sock.groupFetchAllParticipating()

        const found = Object.values(groups)
            .filter(g => g.subject.toLowerCase().includes(name.toLowerCase()))
            .map(g => ({ id: g.id, name: g.subject }))

        log(`🔍 Cari grup "${name}" → ${found.length} ditemukan`)

        if (!found.length)
            return res.status(404).json({ error: "Grup tidak ditemukan" })

        res.json(found)
    } catch (err) {
        log("❌ Gagal cari grup:", err)
        res.status(500).json({ error: err.message })
    }
})

// GROUP MEMBERS
app.get("/group-members/:groupId", async (req, res) => {
    const { groupId } = req.params

    try {
        const metadata = await sock.groupMetadata(groupId)

        const members = metadata.participants.map(p => ({
            id: p.id,
            admin: p.admin || null
        }))

        log(`👥 Ambil member grup ${metadata.subject} → ${members.length} orang`)

        res.json({
            groupId: metadata.id,
            groupName: metadata.subject,
            members
        })
    } catch (err) {
        log("❌ Gagal ambil member:", err)
        res.status(500).json({ error: err.message })
    }
})

// ================= SERVER =================

app.listen(PORT, () => {
    log(`🌐 Server berjalan di http://localhost:${PORT}`)
})
