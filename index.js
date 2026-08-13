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
let reconnectTimer = null
let startWAInProgress = false

const SESSION_RESET_CODES = new Set([])

function resetSessionFiles() {
    fs.rmSync(sessionPath, { recursive: true, force: true })
    fs.mkdirSync(sessionPath, { recursive: true })
}

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

// ================= PIC MAP =================
const PIC_MAP = {
    "70884224147606": {
        name: "Alma",
        sheet: "https://docs.google.com/spreadsheets/d/1AMNL3ksGukcge1PKfryXyl5ltqpG1wJIOxy0AcTCDh8/edit?gid=772573327#gid=772573327"
    },
    "84581344608298": {
        name: "Azzah",
        sheet: "https://docs.google.com/spreadsheets/d/1kwflxpm-fhoTBeXrKiNLG5fpqbePbyHeqJA-BpFK8JU/edit?gid=231053020#gid=231053020"
    },
    "45552674852937": {
        name: "Dhita",
        sheet: "https://docs.google.com/spreadsheets/d/145TubMhBx6uEULDBEWZHai1XlZ8fXWQZxrHflx4qnuE/edit?gid=1854339753#gid=1854339753"
    },
    "138260047257624": {
        name: "Erik",
        sheet: "https://docs.google.com/spreadsheets/d/1q2hLw077h8uJAYJMu3uxT-TxT3HV78DojFAvhI7T7hY/edit?gid=147428211#gid=147428211"
    },
    "61091681939696": {
        name: "Ina",
        sheet: "https://docs.google.com/spreadsheets/d/1cdqnGEwlbPCJUmyvqaOnTdq6y0CPD1PA_r9EzMX9hBY/edit?gid=1626117204#gid=1626117204"
    },
    "177708701057272": {
        name: "Sifa",
        sheet: "https://docs.google.com/spreadsheets/d/1ALfV0mQOTkv4Qjpp7dvx0XVZSn5vXFwcYIxF24GVvLQ/edit?gid=1341989381#gid=1341989381"
    },
    "275071314731206": {
        name: "Rio",
        sheet: "https://docs.google.com/spreadsheets/d/1ALfV0mQOTkv4Qjpp7dvx0XVZSn5vXFwcYIxF24GVvLQ/edit?usp=sharing"
    }
}



function normalizeParticipant(jid = "") {
    const value = typeof jid === "string" ? jid : ""
    return value.split("@")[0]
}


// ================= START WA =================

async function startWA() {
    if (startWAInProgress) return
    startWAInProgress = true

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
        const { version } = await fetchLatestBaileysVersion()

        sock = makeWASocket({
            logger: pino({ level: "silent" }),
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

        sock.ev.on("creds.update", saveCreds)
        log("✅ messages.upsert listener dipasang")

        // ================= AUTO REMINDER GROUP =================

        // const TARGET_GROUP = "120363406595440008@g.us"
        // const TARGET_GROUP = "120363021369281320@g.us"

        const TARGET_GROUPS = [
            "120363406595440008@g.us",
            "120363021369281320@g.us"
        ]
        function getMessageText(msg) {

            return (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                ""
            )

        }

        sock.ev.on("messages.upsert", async ({ messages, type }) => {

            const msg = messages[0]
            if (!msg?.message) return

            const text = getMessageText(msg).trim()

            log("========== PESAN MASUK ==========")
            log("TYPE        :", type)
            log("GROUP       :", msg.key.remoteJid)
            log("FROM        :", msg.key.participant)
            log("FROM ME     :", msg.key.fromMe)
            log("TEXT        :", text)
            log("=================================")

            if (type !== "notify") {
                log("Lewat: bukan notify")
                return
            }

            if (!TARGET_GROUPS.includes(msg.key.remoteJid)) {
                log("Lewat: bukan grup target")
                return
            }

            if (msg.key.fromMe) {
                log("Lewat: pesan sendiri")
                return
            }

            if (!/(ok|oke|0k|0ke)/i.test(text)) {
                log("Lewat: bukan OK")
                return
            }

            log("MATCH -> kirim reminder")

            const sender = normalizeParticipant(msg.key.participant || msg.key.remoteJid)
            const pic = PIC_MAP[sender]

            if (!sender) {
                log("Lewat: participant kosong")
                return
            }

            if (!pic) {
                log(`Nomor ${sender} tidak ada di PIC_MAP`)
                return
            }

            const reminder =
                `Hallo ${pic.name},

Jangan lupa bukti FU di-upload di Paperwork yang sudah disediakan.

Link Google Sheets:
${pic.sheet}`

            try {
                await sock.sendMessage(
                    msg.key.remoteJid,
                    {
                        text: reminder
                    },
                    {
                        quoted: msg
                    }
                )

                log(`Reminder berhasil dikirim ke ${pic.name}`)
            } catch (err) {
                log("Gagal kirim reminder:", err)
            }
        })

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update
            const statusCode = lastDisconnect?.error?.output?.statusCode

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
                const shouldReconnect = true

                log("❌ Terputus. statusCode:", statusCode, "reconnect:", shouldReconnect)
                log("🔒 Session auth dipertahankan; mencoba reconnect tanpa menghapus file session")

                if (reconnectTimer) clearTimeout(reconnectTimer)
                reconnectTimer = setTimeout(() => startWA(), 10000)
            }
        })
    } catch (err) {
        log("❌ Gagal startWA:", err)
        if (String(err?.message || err).includes("Bad MAC")) {
            log("🧹 Bad MAC terdeteksi, membersihkan session auth")
            resetSessionFiles()
        }
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => startWA(), 3000)
    } finally {
        startWAInProgress = false
    }
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


startWA()

// ================= SERVER =================

app.listen(PORT, () => {
    log(`🌐 Server berjalan di http://localhost:${PORT}`)
})
