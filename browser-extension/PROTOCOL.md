# BARQ Downloader — Native Messaging Protocol Specification

**Protocol Version:** 1  
**Transport:** Chromium Native Messaging (stdin/stdout) + Windows Named Pipe (`\\\\.\\pipe\\barq-downloader-ipc`)  

---

## 1. Wire Framing (Browser ↔ Native Host)

In compliance with the Chrome & Microsoft Edge Native Messaging specification:
1. Each message is encoded as UTF-8 JSON.
2. Every message is prefixed with a **32-bit unsigned integer (4 bytes, little-endian)** specifying the length of the JSON string.
3. **Maximum message size:** 1,048,576 bytes (1 MiB). Messages exceeding this ceiling are rejected with `OVERSIZED_MESSAGE`.
4. **Standard Output Rule:** `stdout` is exclusively reserved for framed Native Messaging packets. Diagnostic logging is routed to `stderr` and `native-host.log`.

---

## 2. Operations & Schema

### Operation: `get_status`
Queries whether the BARQ desktop application is running and ready to accept downloads.

#### Request (Extension → Native Host):
```json
{
  "protocolVersion": 1,
  "requestId": "req-1730412345-abc1234",
  "operation": "get_status"
}
```

#### Response (BARQ Running):
```json
{
  "protocolVersion": 1,
  "requestId": "req-1730412345-abc1234",
  "ok": true,
  "status": "ready",
  "version": "0.1.0",
  "activeTransfers": 2,
  "message": "BARQ Downloader is running and ready."
}
```

#### Response (BARQ Not Running):
```json
{
  "protocolVersion": 1,
  "requestId": "req-1730412345-abc1234",
  "ok": false,
  "status": "unavailable",
  "code": "BARQ_NOT_RUNNING",
  "message": "BARQ Downloader is not running. Please launch BARQ Downloader."
}
```

---

### Operation: `submit_download`
Submits a downloadable URL to the BARQ download queue.

#### Request (Extension → Native Host):
```json
{
  "protocolVersion": 1,
  "requestId": "req-1730412345-xyz7890",
  "operation": "submit_download",
  "payload": {
    "url": "https://example.com/software.zip",
    "source": "context_menu",
    "filenameHint": "software.zip"
  }
}
```

#### Response (Accepted):
```json
{
  "protocolVersion": 1,
  "requestId": "req-1730412345-xyz7890",
  "ok": true,
  "status": "accepted",
  "downloadId": 42,
  "filename": "software.zip",
  "message": "Download \"software.zip\" added to BARQ Downloader."
}
```

#### Response (Rejected — Invalid URL):
```json
{
  "protocolVersion": 1,
  "requestId": "req-1730412345-xyz7890",
  "ok": false,
  "code": "INVALID_URL",
  "message": "Unsupported scheme \"file\". Only http and https are allowed."
}
```

---

## 3. Desktop Authentication & Named Pipe

Between `barq-native-host.js` and `BARQ Downloader`:
- **Named Pipe:** `\\\\.\\pipe\\barq-downloader-ipc`
- **Secret Token:** Stored at `layout.dataDir/ipc-secret.dat` (mode `0600`).
- **Timing Safe Verification:** Authenticated using `crypto.timingSafeEqual` to prevent timing attacks.
- **Idempotency:** Unique `requestId` values are cached for 60 seconds. Rapid duplicate clicks replay the cached response rather than duplicating SQLite download records.
