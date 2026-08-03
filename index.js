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
    if (!authHeader || !authHeader.startsWith("Bearer "))
        return res.status(401).json({ error: "Token wajib disertakan" })

    if (authHeader.split(" ")[1] !== AUTH_TOKEN)
        return res.status(403).json({ error: "Token tidak valid" })

    next()
})

// ================= SESSION =================

const sessionPath = path.join(process.cwd(), "session")
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true })
}

let sock

// ================= GROUP CACHE =================

const groupCache = new Map()

async function preloadGroupCache() {
    const groups = await sock.groupFetchAllParticipating()
    Object.keys(groups).forEach(jid => {
        groupCache.set(jid, groups[jid])
    })
    log(`⚡ Cache preload: ${groupCache.size} grup`)
}

async function getGroupMeta(jid) {
    if (groupCache.has(jid)) return groupCache.get(jid)
    const meta = await sock.groupMetadata(jid)
    groupCache.set(jid, meta)
    return meta
}

// ================= START WA =================

async function startWA() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: state,
        version,
        browser: ["WA API", "Chrome", "1.0"],

        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,

        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 0,

        keepAliveIntervalMs: 15_000,
        emitOwnEvents: false
    })

    // START AUTO REMINDER
    setupAutoReminder()

    sock.ev.on("creds.update", saveCreds)

    // TEST EVENT
    sock.ev.on("messages.upsert", async ({ messages, type }) => {

        log("🔥 EVENT MESSAGE MASUK", type)

        const msg = messages[0]

        if (!msg?.message) {
            log("❌ Tidak ada message")
            return
        }


        log({
            jid: msg.key.remoteJid,
            fromMe: msg.key.fromMe,
            participant: msg.key.participant
        })

    })

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            log("📱 Scan QR untuk login")
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            groupCache.clear()
            await preloadGroupCache()
            log("✅ WhatsApp siap digunakan")
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            log("❌ Terputus, reconnect:", shouldReconnect)

            if (shouldReconnect) startWA()
        }
    })
}

// ================= UTIL =================

const normalizeNumber = (number) =>
    number.replace(/\D/g, "") + "@s.whatsapp.net"

// ================= API =================

// SEND PERSONAL
app.post("/send-person", async (req, res) => {
    const { contactId, message } = req.body

    if (!contactId || !message)
        return res.status(400).json({ error: "contactId & message wajib diisi" })

    const jid = normalizeNumber(contactId)
    log(`📤 Kirim ke ${jid}`)

    res.json({ success: true, message: "Pesan sedang dikirim" })

    sock.sendMessage(jid, { text: message })
        .then(() => log(`✅ Terkirim ke ${jid}`))
        .catch(err => log("❌ Gagal kirim:", err))
})

// SEND GROUP
app.post("/send-group", async (req, res) => {
    const { groupId, message } = req.body

    if (!groupId || !message)
        return res.status(400).json({ error: "groupId & message wajib diisi" })

    log(`📤 Kirim ke grup ${groupId}`)

    res.json({ success: true, message: "Pesan sedang dikirim" })

    getGroupMeta(groupId)
        .then(() => sock.sendMessage(groupId, { text: message }))
        .then(() => log(`✅ Grup terkirim ${groupId}`))
        .catch(err => log("❌ Gagal kirim grup:", err))

})

// GET GROUP LIST
app.get("/groups", async (req, res) => {
    const groups = await sock.groupFetchAllParticipating()

    const list = Object.values(groups).map(g => ({
        id: g.id,
        name: g.subject
    }))

    res.json(list)
})

// ================= AUTO REMINDER GROUP =================

const TARGET_GROUP = "120363406595440008@g.us"

const processedMessages = new Set()

function getMessageText(msg) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ""
    )
}


function setupAutoReminder() {

    sock.ev.on("messages.upsert", async ({ messages, type }) => {

        if (type !== "notify") return

        const msg = messages[0]

        if (!msg?.message) return


        // anti double proses
        const messageId = msg.key.id

        if (processedMessages.has(messageId)) return

        processedMessages.add(messageId)


        // hanya group tertentu
        if (msg.key.remoteJid !== TARGET_GROUP) return


        // abaikan pesan dari bot sendiri
        if (msg.key.fromMe) return


        const text = getMessageText(msg)
            .trim()
            .toLowerCase()

        // LOG PESAN MASUK
        log(
            "📩 Pesan masuk:",
            {
                dari: msg.key.participant || msg.key.remoteJid,
                group: msg.key.remoteJid,
                pesan: text
            }
        )

        // trigger OK / OKE / 0K / 0KE
        if (!/^(ok|oke|0k|0ke)$/i.test(text)) {
            return
        }


        try {

            await sock.sendMessage(
                TARGET_GROUP,
                {
                    text: "Jangan lupa bukti FU di-upload di Paperwork yang sudah disediakan.  "
                },
                {
                    quoted: msg
                }
            )


            log("✅ Auto reminder terkirim")

        } catch (err) {

            log(
                "❌ Auto reminder gagal:",
                err.message
            )

        }

    })

}


startWA()

// ================= SERVER =================

app.listen(PORT, () => {
    log(`🌐 Server berjalan di http://localhost:${PORT}`)
})
