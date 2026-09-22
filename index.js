
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
import { fileURLToPath } from "url"
import { installLogFilter } from "./logFilter.js"

dotenv.config()

installLogFilter()

// =====================================================
// LOGGER
// =====================================================

const log = (...args) => {
    const now = new Date()

    const time = now.toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour12: false
    })

    console.log(`[${time}]`, ...args)
}

// =====================================================
// APP INIT
// =====================================================

const app = express()

app.use(express.json())
app.use(cors())

const PORT = process.env.PORT || 3008
const AUTH_TOKEN = process.env.AUTH_TOKEN || "123456"

// =====================================================
// AUTH MIDDLEWARE
// =====================================================

app.use((req, res, next) => {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Token wajib disertakan"
        })
    }

    const token = authHeader.split(" ")[1]

    if (token !== AUTH_TOKEN) {
        return res.status(403).json({
            error: "Token tidak valid"
        })
    }

    next()
})

// =====================================================
// SESSION
// =====================================================

const appDirectory = path.dirname(
    fileURLToPath(import.meta.url)
)

const sessionPath =
    process.env.SESSION_PATH ||
    path.join(appDirectory, "session")

if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, {
        recursive: true
    })
}

const existingSessionDetect = path.join(
    sessionPath,
    "creds.json"
)

const hasExistingSession =
    fs.existsSync(existingSessionDetect)

log(`📁 Auth session: ${sessionPath}`)

// =====================================================
// GLOBAL SOCKET STATE
// =====================================================

let sock = null

let waConnection = "close"

let reconnectTimer = null

let startWAInProgress = false

let reconnectAttempts = 0

let socketGeneration = 0

let shutdownRequested = false

let baileysVersion = null

// =====================================================
// RECONNECT STATE
// =====================================================

function resetReconnectState() {
    reconnectAttempts = 0

    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
}

// =====================================================
// DISCONNECT HANDLING
// =====================================================

function getStatusCode(lastDisconnect) {
    return (
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.data?.statusCode ||
        null
    )
}

function getDisconnectMessage(lastDisconnect) {
    return (
        lastDisconnect?.error?.message ||
        String(lastDisconnect?.error || "") ||
        "unknown"
    )
}

function isRecoverableDisconnect(statusCode) {

    if (!statusCode) {
        return true
    }

    // =================================================
    // REASON YANG TIDAK BOLEH AUTO RECONNECT
    // =================================================

    const permanentReasons = new Set([
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.forbidden,
        DisconnectReason.connectionReplaced,
        DisconnectReason.multideviceMismatch
    ])

    if (permanentReasons.has(statusCode)) {
        return false
    }

    // =================================================
    // REASON YANG UMUMNYA BISA RECOVER
    // =================================================

    const recoverableReasons = new Set([
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        DisconnectReason.timedOut,
        DisconnectReason.restartRequired,
        DisconnectReason.wsDisconnected,
        DisconnectReason.wsConnectionDropped,
        DisconnectReason.wsConnectionDroppedCount,
        DisconnectReason.unavailableService
    ])

    if (recoverableReasons.has(statusCode)) {
        return true
    }

    // =================================================
    // UNTUK STATUS UNKNOWN:
    // LEBIH BAIK COBA RECONNECT
    // DARIPADA MEMATIKAN SERVICE
    // =================================================

    return true
}

// =====================================================
// CLOSE CURRENT SOCKET
// =====================================================

async function closeCurrentSocket(reason = "unknown") {

    const currentSocket = sock

    if (!currentSocket) {
        return
    }

    log(`🔌 Menutup socket lama. Reason: ${reason}`)

    try {

        if (currentSocket.ws) {
            currentSocket.ws.close()
        }

    } catch (err) {

        log(
            "⚠️ Gagal menutup WebSocket lama:",
            err?.message || err
        )

    }

    if (sock === currentSocket) {
        sock = null
    }

    waConnection = "close"
}

// =====================================================
// RECONNECT SCHEDULER
// =====================================================

function scheduleStartWA(delay = 10000) {

    if (shutdownRequested) {
        return
    }

    if (reconnectTimer) {
        return
    }

    if (startWAInProgress) {
        log("⏳ startWA masih berjalan. Reconnect tidak dibuat.")
        return
    }

    const reconnectDelay = Math.min(
        delay * 2 ** reconnectAttempts,
        60_000
    )

    log(
        `🔁 Reconnect ke-${reconnectAttempts + 1} ` +
        `dijadwalkan dalam ${Math.ceil(
            reconnectDelay / 1000
        )} detik`
    )

    reconnectTimer = setTimeout(async () => {

        reconnectTimer = null

        reconnectAttempts += 1

        await startWA()

    }, reconnectDelay)
}

// =====================================================
// BAILEYS VERSION
// =====================================================

async function getBaileysVersion() {

    if (baileysVersion) {
        return baileysVersion
    }

    try {

        const result =
            await fetchLatestBaileysVersion()

        baileysVersion = result.version

        log(
            `📦 Baileys WA version: ${baileysVersion.join(".")}`
        )

        if (result.isLatest === false) {
            log(
                "⚠️ Version Baileys yang digunakan bukan latest."
            )
        }

        return baileysVersion

    } catch (err) {

        log(
            "⚠️ Gagal mengambil versi Baileys:",
            err?.message || err
        )

        // fallback
        return undefined
    }
}

// =====================================================
// GROUP CACHE
// =====================================================

const groupCache = new Map()

async function preloadGroupCache() {

    if (!sock) {
        return
    }

    try {

        const groups =
            await sock.groupFetchAllParticipating()

        Object.keys(groups).forEach(jid => {

            groupCache.set(
                jid,
                groups[jid]
            )

        })

        log(
            `⚡ Cache preload: ${groupCache.size} grup`
        )

    } catch (err) {

        log(
            "⚠️ Gagal preload cache grup:",
            err?.message || err
        )

    }
}

async function getGroupMeta(jid) {

    if (!sock) {
        throw new Error("WhatsApp socket belum tersedia")
    }

    if (groupCache.has(jid)) {
        return groupCache.get(jid)
    }

    const meta =
        await sock.groupMetadata(jid)

    groupCache.set(jid, meta)

    return meta
}

// =====================================================
// PIC MAP
// =====================================================

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

// =====================================================
// NORMALIZE PARTICIPANT
// =====================================================

function normalizeParticipant(jid = "") {

    const value =
        typeof jid === "string"
            ? jid
            : ""

    return value.split("@")[0]
}

// =====================================================
// START WHATSAPP
// =====================================================

async function startWA() {

    if (shutdownRequested) {
        log("🛑 Shutdown sedang berlangsung.")
        return
    }

    // =================================================
    // PROTEKSI DUPLICATE START
    // =================================================

    if (startWAInProgress) {

        log(
            "⏳ startWA sedang berjalan. Start baru dibatalkan."
        )

        return
    }

    startWAInProgress = true

    const currentSocketGeneration =
        ++socketGeneration

    log(
        `🚀 Memulai WhatsApp socket generation=${currentSocketGeneration}`
    )

    try {

        // =================================================
        // PASTIKAN SOCKET LAMA DITUTUP
        // =================================================

        if (sock) {

            log(
                "⚠️ Masih terdapat socket lama. Menutup sebelum membuat socket baru."
            )

            await closeCurrentSocket(
                "before-new-socket"
            )

            // Beri sedikit waktu WebSocket benar-benar close
            await new Promise(resolve =>
                setTimeout(resolve, 1000)
            )
        }

        // =================================================
        // SESSION
        // =================================================

        if (hasExistingSession) {

            log(
                "🛡️ Session existing dipertahankan. " +
                "Tidak menghapus atau reset folder auth."
            )

        } else {

            log(
                "ℹ️ Belum ada session tersimpan. " +
                "Session baru akan dibuat saat QR login berhasil."
            )

        }

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            sessionPath
        )

        if (!state) {

            log(
                "⚠️ Auth state belum siap. Reconnect nanti."
            )

            scheduleStartWA(3000)

            return
        }

        // =================================================
        // BAILEYS VERSION
        // =================================================

        const version =
            await getBaileysVersion()

        // =================================================
        // CREATE SOCKET
        // =================================================

        const newSocket =
            makeWASocket({

                logger: pino({
                    level: "silent"
                }),

                auth: state,

                ...(version
                    ? { version }
                    : {}),

                browser: [
                    "WA API",
                    "Chrome",
                    "1.0"
                ],

                syncFullHistory: false,

                markOnlineOnConnect: false,

                generateHighQualityLinkPreview: false,

                connectTimeoutMs: 60_000,

                defaultQueryTimeoutMs: 60_000,

                keepAliveIntervalMs: 15_000,

                emitOwnEvents: false
            })

        // =================================================
        // ASSIGN SOCKET
        // =================================================

        sock = newSocket

        waConnection = "connecting"

        log(
            `🔌 Socket baru dibuat. generation=${currentSocketGeneration}`
        )

        // =================================================
        // SAVE CREDENTIALS
        // =================================================

        newSocket.ev.on(
            "creds.update",
            saveCreds
        )

        log(
            "💾 creds.update listener dipasang"
        )

        // =================================================
        // TARGET GROUP
        // =================================================

        const TARGET_GROUPS = [

            "120363406595440008@g.us",

            "120363021369281320@g.us"

        ]

        // =================================================
        // GET MESSAGE TEXT
        // =================================================

        function getMessageText(msg) {

            return (

                msg.message?.conversation ||

                msg.message?.extendedTextMessage?.text ||

                msg.message?.imageMessage?.caption ||

                msg.message?.videoMessage?.caption ||

                ""

            )
        }

        // =================================================
        // MESSAGE HANDLER
        // =================================================

        newSocket.ev.on(
            "messages.upsert",
            async ({ messages, type }) => {

                // =================================================
                // IGNORE OLD SOCKET
                // =================================================

                if (
                    currentSocketGeneration !==
                    socketGeneration
                ) {
                    return
                }

                for (const msg of messages || []) {

                    try {

                        if (!msg?.message) {
                            continue
                        }

                        const text =
                            getMessageText(msg)
                                .trim()

                        log(
                            "========== PESAN MASUK =========="
                        )

                        log(
                            "TYPE        :",
                            type
                        )

                        log(
                            "GROUP       :",
                            msg.key.remoteJid
                        )

                        log(
                            "FROM        :",
                            msg.key.participant
                        )

                        log(
                            "FROM ME     :",
                            msg.key.fromMe
                        )

                        log(
                            "TEXT        :",
                            text
                        )

                        log(
                            "================================="
                        )

                        // =================================================
                        // VALIDASI TYPE
                        // =================================================

                        if (
                            type !== "notify" ||
                            !TARGET_GROUPS.includes(
                                msg.key.remoteJid
                            )
                        ) {

                            log(
                                "Lewat: bukan pesan notify dari target group"
                            )

                            continue
                        }

                        // =================================================
                        // PESAN SENDIRI
                        // =================================================

                        if (msg.key.fromMe) {

                            log(
                                "Lewat: pesan sendiri"
                            )

                            continue
                        }

                        // =================================================
                        // MATCH OK
                        // =================================================

                        if (
                            !/(ok|oke|0k|0ke)/i
                                .test(text)
                        ) {

                            log(
                                "Lewat: bukan OK"
                            )

                            continue
                        }

                        log(
                            "MATCH -> kirim reminder"
                        )

                        // =================================================
                        // CEK CONNECTION
                        // =================================================

                        if (
                            waConnection !== "open"
                        ) {

                            log(
                                "Lewat: koneksi WhatsApp belum terbuka"
                            )

                            continue
                        }

                        // =================================================
                        // SENDER
                        // =================================================

                        const sender =
                            normalizeParticipant(
                                msg.key.participant ||
                                msg.key.remoteJid
                            )

                        if (!sender) {

                            log(
                                "Lewat: participant kosong"
                            )

                            continue
                        }

                        // =================================================
                        // PIC
                        // =================================================

                        const pic =
                            PIC_MAP[sender]

                        if (!pic) {

                            log(
                                `Nomor ${sender} tidak ada di PIC_MAP`
                            )

                            continue
                        }

                        // =================================================
                        // REMINDER
                        // =================================================

                        const reminder =
                            `Hallo ${pic.name},

Jangan lupa bukti FU di-upload di Paperwork yang sudah disediakan.

Link Google Sheets:
${pic.sheet}`

                        // =================================================
                        // SEND
                        // =================================================

                        await newSocket.sendMessage(

                            msg.key.remoteJid,

                            {
                                text: reminder
                            },

                            {
                                quoted: msg
                            }

                        )

                        log(
                            `Reminder berhasil dikirim ke ${pic.name}`
                        )

                    } catch (err) {

                        log(
                            "❌ Error messages.upsert:",
                            err?.message || err
                        )

                    }
                }
            }
        )

        // =================================================
        // CONNECTION UPDATE
        // =================================================

        newSocket.ev.on(
            "connection.update",
            async update => {

                // =================================================
                // IGNORE OLD SOCKET
                // =================================================

                if (
                    currentSocketGeneration !==
                    socketGeneration
                ) {

                    log(
                        `⚠️ Event dari socket lama diabaikan. generation=${currentSocketGeneration}`
                    )

                    return
                }

                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update

                const statusCode =
                    getStatusCode(
                        lastDisconnect
                    )

                const disconnectMessage =
                    getDisconnectMessage(
                        lastDisconnect
                    )

                // =================================================
                // QR
                // =================================================

                if (qr) {

                    log(
                        "📱 Scan QR untuk login"
                    )

                    qrcode.generate(
                        qr,
                        {
                            small: true
                        }
                    )
                }

                // =================================================
                // CONNECTING
                // =================================================

                if (connection === "connecting") {

                    waConnection = "connecting"

                    log(
                        "🔄 WhatsApp sedang connecting..."
                    )
                }

                // =================================================
                // OPEN
                // =================================================

                if (connection === "open") {

                    if (
                        currentSocketGeneration !==
                        socketGeneration
                    ) {
                        return
                    }

                    waConnection = "open"

                    groupCache.clear()

                    log(
                        "================================="
                    )

                    log(
                        "✅ WHATSAPP CONNECTED"
                    )

                    log(
                        `Generation : ${currentSocketGeneration}`
                    )

                    log(
                        "Session    : aktif"
                    )

                    log(
                        "================================="
                    )

                    // =================================================
                    // RESET RECONNECT
                    // =================================================

                    resetReconnectState()

                    // =================================================
                    // OPTIONAL GROUP PRELOAD
                    // =================================================
                    //
                    // Sengaja TIDAK melakukan:
                    //
                    // await preloadGroupCache()
                    //
                    // setiap reconnect.
                    //
                    // Metadata grup akan diambil ketika dibutuhkan.
                    // =================================================

                    log(
                        "✅ WhatsApp siap digunakan"
                    )
                }

                // =================================================
                // CLOSE
                // =================================================

                if (connection === "close") {

                    if (
                        currentSocketGeneration !==
                        socketGeneration
                    ) {
                        return
                    }

                    waConnection = "close"

                    const isLoggedOut =
                        statusCode ===
                        DisconnectReason.loggedOut

                    const shouldReconnect =
                        isRecoverableDisconnect(
                            statusCode
                        )

                    log(
                        "================================="
                    )

                    log(
                        "❌ WHATSAPP DISCONNECTED"
                    )

                    log(
                        "Generation :",
                        currentSocketGeneration
                    )

                    log(
                        "StatusCode :",
                        statusCode
                    )

                    log(
                        "Message    :",
                        disconnectMessage
                    )

                    log(
                        "Reconnect  :",
                        shouldReconnect
                    )

                    log(
                        "================================="
                    )

                    // =================================================
                    // LOGGED OUT
                    // =================================================

                    if (isLoggedOut) {

                        log(
                            "🔒 WhatsApp menganggap session logout."
                        )

                        log(
                            "📱 Scan QR diperlukan untuk login kembali."
                        )

                        resetReconnectState()

                        return
                    }

                    // =================================================
                    // PERMANENT DISCONNECT
                    // =================================================

                    if (!shouldReconnect) {

                        log(
                            "🛑 Disconnect reason tidak dapat dipulihkan otomatis."
                        )

                        log(
                            "🛑 Reconnect otomatis dihentikan."
                        )

                        resetReconnectState()

                        return
                    }

                    // =================================================
                    // RECOVERABLE DISCONNECT
                    // =================================================

                    log(
                        "🔄 Disconnect dapat dipulihkan."
                    )

                    log(
                        "🔒 Session auth tetap dipertahankan."
                    )

                    // =================================================
                    // PENTING:
                    // SOCKET YANG MENYEBABKAN EVENT CLOSE
                    // JANGAN DIPAKAI LAGI
                    // =================================================

                    if (sock === newSocket) {
                        sock = null
                    }

                    groupCache.clear()

                    // =================================================
                    // RECONNECT
                    // =================================================

                    scheduleStartWA(5000)
                }
            }
        )

        // =================================================
        // ERROR EVENT
        // =================================================

        newSocket.ev.on(
            "error",
            err => {

                if (
                    currentSocketGeneration !==
                    socketGeneration
                ) {
                    return
                }

                log(
                    "⚠️ Socket error:",
                    err?.message || err
                )
            }
        )

    } catch (err) {

        log(
            "❌ Gagal startWA:",
            err?.message || err
        )

        // =================================================
        // BAD MAC
        // =================================================

        if (
            String(
                err?.message || err
            ).includes("Bad MAC")
        ) {

            log(
                "⚠️ Bad MAC terdeteksi."
            )

            log(
                "⚠️ File session TIDAK dihapus otomatis."
            )

            log(
                "⚠️ Hapus folder session secara manual hanya jika memang ingin login ulang."
            )
        }

        // =================================================
        // RECONNECT
        // =================================================

        if (
            !shutdownRequested
        ) {

            scheduleStartWA(3000)

        }

    } finally {

        startWAInProgress = false

    }
}

// =====================================================
// UTIL
// =====================================================

const normalizeNumber = number => {

    const normalized =
        String(number)
            .replace(/\D/g, "")

    return (
        normalized +
        "@s.whatsapp.net"
    )
}

// =====================================================
// API
// =====================================================

// =====================================================
// SEND PERSONAL
// =====================================================

app.post(
    "/send-person",
    async (req, res) => {

        const {
            contactId,
            message
        } = req.body

        if (
            !contactId ||
            !message
        ) {

            return res.status(400).json({
                error:
                    "contactId & message wajib diisi"
            })

        }

        const jid =
            normalizeNumber(contactId)

        if (
            waConnection !== "open" ||
            !sock
        ) {

            return res.status(503).json({
                error:
                    "WhatsApp belum terhubung"
            })

        }

        log(
            `📤 Kirim ke ${jid}`
        )

        // =================================================
        // RESPONSE DULU
        // =================================================

        res.json({
            success: true,
            message:
                "Pesan sedang dikirim"
        })

        // =================================================
        // SEND
        // =================================================

        try {

            await sock.sendMessage(
                jid,
                {
                    text: message
                }
            )

            log(
                `✅ Terkirim ke ${jid}`
            )

        } catch (err) {

            log(
                "❌ Gagal kirim:",
                err?.message || err
            )

        }
    }
)

// =====================================================
// SEND GROUP
// =====================================================

app.post(
    "/send-group",
    async (req, res) => {

        const {
            groupId,
            message
        } = req.body

        if (
            !groupId ||
            !message
        ) {

            return res.status(400).json({
                error:
                    "groupId & message wajib diisi"
            })

        }

        if (
            waConnection !== "open" ||
            !sock
        ) {

            return res.status(503).json({
                error:
                    "WhatsApp belum terhubung"
            })

        }

        log(
            `📤 Kirim ke grup ${groupId}`
        )

        res.json({
            success: true,
            message:
                "Pesan sedang dikirim"
        })

        try {

            // =================================================
            // GET GROUP META
            // =================================================

            await getGroupMeta(
                groupId
            )

            // =================================================
            // SEND
            // =================================================

            await sock.sendMessage(
                groupId,
                {
                    text: message
                }
            )

            log(
                `✅ Grup terkirim ${groupId}`
            )

        } catch (err) {

            log(
                "❌ Gagal kirim grup:",
                err?.message || err
            )

        }
    }
)

// =====================================================
// GET GROUP LIST
// =====================================================

app.get(
    "/groups",
    async (req, res) => {

        try {

            if (
                waConnection !== "open" ||
                !sock
            ) {

                return res.status(503).json({
                    error:
                        "WhatsApp belum terhubung"
                })

            }

            const groups =
                await sock.groupFetchAllParticipating()

            const list =
                Object.values(groups)
                    .map(group => ({
                        id: group.id,
                        name: group.subject
                    }))

            res.json(list)

        } catch (err) {

            log(
                "❌ Gagal mengambil group list:",
                err?.message || err
            )

            res.status(500).json({
                error:
                    "Gagal mengambil daftar grup"
            })
        }
    }
)

// =====================================================
// STATUS API
// =====================================================

app.get(
    "/status",
    async (req, res) => {

        res.json({

            success: true,

            whatsapp: waConnection,

            socket:
                sock
                    ? "active"
                    : "none",

            generation:
                socketGeneration,

            reconnectAttempts:
                reconnectAttempts,

            session:
                fs.existsSync(
                    path.join(
                        sessionPath,
                        "creds.json"
                    )
                )
                    ? "exists"
                    : "none"

        })

    }
)

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

async function gracefulShutdown(
    signal
) {

    if (shutdownRequested) {
        return
    }

    shutdownRequested = true

    log(
        `🛑 Shutdown signal: ${signal}`
    )

    // =================================================
    // STOP RECONNECT TIMER
    // =================================================

    if (reconnectTimer) {

        clearTimeout(
            reconnectTimer
        )

        reconnectTimer = null
    }

    // =================================================
    // INVALIDATE OLD SOCKET EVENTS
    // =================================================

    socketGeneration++

    // =================================================
    // CLOSE SOCKET
    // =================================================

    try {

        if (sock?.ws) {

            log(
                "🔌 Menutup WhatsApp WebSocket..."
            )

            sock.ws.close()

        }

    } catch (err) {

        log(
            "⚠️ Error saat shutdown socket:",
            err?.message || err
        )

    }

    sock = null

    waConnection = "close"

    // =================================================
    // CLOSE SERVER
    // =================================================

    server.close(() => {

        log(
            "✅ HTTP server berhenti."
        )

        process.exit(0)

    })

    // =================================================
    // FORCE EXIT
    // =================================================

    setTimeout(() => {

        log(
            "⚠️ Force shutdown."
        )

        process.exit(1)

    }, 10_000)
}

// =====================================================
// START WHATSAPP
// =====================================================

startWA()

// =====================================================
// SERVER
// =====================================================

const server =
    app.listen(
        PORT,
        () => {

            log(
                `🌐 Server berjalan di http://localhost:${PORT}`
            )

            log(
                `📡 WhatsApp service aktif di port ${PORT}`
            )

        }
    )

// =====================================================
// PROCESS SIGNAL
// =====================================================

process.on(
    "SIGINT",
    () => gracefulShutdown("SIGINT")
)

process.on(
    "SIGTERM",
    () => gracefulShutdown("SIGTERM")
)

// =====================================================
// UNHANDLED ERROR
// =====================================================

process.on(
    "unhandledRejection",
    reason => {

        log(
            "⚠️ Unhandled Promise Rejection:",
            reason
        )

    }
)

process.on(
    "uncaughtException",
    error => {

        log(
            "❌ Uncaught Exception:",
            error?.message || error
        )

    }
)
