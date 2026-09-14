const NOISY_SESSION_PATTERNS = [
    "Closing session",
    "SessionEntry",
    "_chains",
    "Decrypted message with closed session.",
    "Removing old closed session:",
    "Session already closed",
    "Opening session:"
]

export function isFilteredLogMessage(args) {
    const first = typeof args?.[0] === "string" ? args[0] : ""
    return NOISY_SESSION_PATTERNS.some(pattern => first.includes(pattern))
}

export function installLogFilter() {
    const originalLog = console.log
    console.log = (...args) => {
        if (isFilteredLogMessage(args)) return
        originalLog(...args)
    }
}
