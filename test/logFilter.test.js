import test from "node:test"
import assert from "node:assert/strict"
import { isFilteredLogMessage } from "../logFilter.js"

test("filter recognizes noisy Baileys/libsignal session messages", () => {
    assert.equal(isFilteredLogMessage(["Decrypted message with closed session."]), true)
    assert.equal(isFilteredLogMessage(["Closing session: SessionEntry"]), true)
    assert.equal(isFilteredLogMessage(["Opening session: SessionEntry"]), true)
    assert.equal(isFilteredLogMessage(["Removing old closed session:", { a: 1 }]), true)
    assert.equal(isFilteredLogMessage(["normal message"]), false)
})
