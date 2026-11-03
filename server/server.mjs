#!/usr/bin/env node
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { Tokenizer } from "@huggingface/tokenizers"
import ort from "onnxruntime-node"

const MODEL_REPO = "@modelRepo@"
const MODEL_REVISION = "@modelRevision@"

const HOST = process.env.PRIVACY_FILTER_HOST ?? "127.0.0.1"
const PORT = Number(process.env.PRIVACY_FILTER_PORT ?? 8787)
const CACHE =
  process.env.PRIVACY_FILTER_CACHE ??
  path.join(process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? ".", ".cache"), "privacy-filter")
const THREADS = Number(process.env.PRIVACY_FILTER_THREADS ?? Math.min(8, os.cpus().length))
const MAX_TOKENS = Number(process.env.PRIVACY_FILTER_MAX_TOKENS ?? 2048)
const IDLE_MS = Number(process.env.PRIVACY_FILTER_IDLE_MS ?? 120_000)
const REQUEST_TIMEOUT_MS = Number(process.env.PRIVACY_FILTER_REQUEST_TIMEOUT_MS ?? 30_000)
const OVERLAP = 128
const MAX_BODY = 16 * 1024 * 1024
const MAX_TEXTS = 2000
const SEPARATOR = "\n\n"

const FILES = {
  "model_q4.onnx": "onnx/model_q4.onnx",
  "model_q4.onnx_data": "onnx/model_q4.onnx_data",
  "tokenizer.json": "tokenizer.json",
  "tokenizer_config.json": "tokenizer_config.json",
  "config.json": "config.json",
}

let ready = false
let tokenizer = null
let session = null
let id2label = null
let queue = Promise.resolve()
let inFlight = false
let lastUsed = Date.now()

async function download(name, remote) {
  const target = path.join(CACHE, name)
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) return target
  fs.mkdirSync(CACHE, { recursive: true })
  const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${remote}`
  const tmp = `${target}.tmp`
  console.error(`privacy-filter: downloading ${name}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download ${name}: HTTP ${response.status}`)
  const out = fs.createWriteStream(tmp)
  for await (const chunk of response.body) out.write(chunk)
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
  fs.renameSync(tmp, target)
  return target
}

async function load() {
  for (const [name, remote] of Object.entries(FILES)) await download(name, remote)
  const config = JSON.parse(fs.readFileSync(path.join(CACHE, "config.json"), "utf8"))
  id2label = Object.fromEntries(Object.entries(config.id2label).map(([key, value]) => [Number(key), value]))
  tokenizer = new Tokenizer(
    JSON.parse(fs.readFileSync(path.join(CACHE, "tokenizer.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(CACHE, "tokenizer_config.json"), "utf8")),
  )
  session = await ort.InferenceSession.create(path.join(CACHE, "model_q4.onnx"), {
    executionProviders: ["cpu"],
    intraOpNumThreads: THREADS,
    graphOptimizationLevel: "all",
  })
  ready = true
  console.error(`privacy-filter: model ready (${THREADS} threads)`)}

// Byte-level BPE token -> raw text piece.
const BYTE_MAP = (() => {
  const bytes = []
  const chars = []
  for (let value = 0; value < 256; value++) {
    bytes.push(value)
    chars.push(value)
  }
  let extra = 0
  for (let value = 0; value < 256; value++) {
    if (
      (value >= 33 && value <= 126) ||
      (value >= 161 && value <= 172) ||
      (value >= 174 && value <= 255)
    )
      continue
    bytes.push(value)
    chars.push(256 + extra++)
  }
  const map = new Map()
  for (let index = 0; index < bytes.length; index++) map.set(String.fromCharCode(chars[index]), bytes[index])
  return map
})()

function decodeToken(token) {
  return Buffer.from([...token].map((char) => BYTE_MAP.get(char))).toString("utf8")
}

function trim(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  return [start, end]
}

function offsetsFor(text, tokens) {
  let position = 0
  return tokens.map((token) => {
    const piece = decodeToken(token)
    if (!piece) return [0, 0]
    let index = text.indexOf(piece, position)
    if (index < 0) index = position
    position = index + piece.length
    return [index, position]
  })
}

function decodeTags(tags, offsets, base, text) {
  const spans = []
  let label = null
  let start = 0
  const emit = (first, last, name) => {
    const a = offsets[base + first]?.[0]
    const b = offsets[base + last]?.[1]
    if (a === undefined || b === undefined || b <= a) return
    const [s, e] = trim(text, a, b)
    if (e > s) spans.push([s, e, name])
  }
  tags.forEach((tagId, index) => {
    const tag = id2label[tagId]
    if (tag === "O") {
      if (label !== null) emit(start, index - 1, label)
      label = null
      return
    }
    const kind = tag[0]
    const name = tag.slice(2)
    if (kind === "S") {
      if (label !== null) emit(start, index - 1, label)
      label = null
      emit(index, index, name)
    } else if (kind === "B") {
      if (label !== null) emit(start, index - 1, label)
      label = name
      start = index
    } else if (kind === "I") {
      if (label !== name) {
        if (label !== null) emit(start, index - 1, label)
        label = name
        start = index
      }
    } else if (kind === "E") {
      if (label !== name) {
        if (label !== null) emit(start, index - 1, label)
        label = name
        start = index
      }
      emit(start, index, name)
      label = null
    }
  })
  if (label !== null) emit(start, tags.length - 1, label)
  return spans
}

async function spansFor(text) {
  const encoding = tokenizer.encode(text)
  const ids = encoding.ids
  const offsets = offsetsFor(text, encoding.tokens)
  const spans = []
  const step = Math.max(1, MAX_TOKENS - OVERLAP)
  for (let base = 0; base < ids.length; base += step) {
    const window = ids.slice(base, base + MAX_TOKENS)
    if (window.length === 0) break
    const feeds = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(window.map(BigInt)), [1, window.length]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(window.map(() => 1n)), [1, window.length]),
    }
    const output = await session.run(feeds)
    const logits = output[Object.keys(output)[0]]
    const [, tokens, classes] = logits.dims
    const tags = new Array(tokens)
    for (let token = 0; token < tokens; token++) {
      let best = 0
      let bestValue = -Infinity
      for (let cls = 0; cls < classes; cls++) {
        const value = logits.data[token * classes + cls]
        if (value > bestValue) {
          bestValue = value
          best = cls
        }
      }
      tags[token] = best
    }
    spans.push(...decodeTags(tags, offsets, base, text))
  }
  const unique = new Map()
  for (const [start, end, label] of spans) unique.set(`${start}:${end}:${label}`, [start, end, label])
  return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

function applySpans(text, spans) {
  const pieces = []
  let cursor = 0
  for (const [start, end, label] of spans) {
    if (start < cursor || end > text.length) continue
    pieces.push(text.slice(cursor, start), `[REDACTED:${label}]`)
    cursor = end
  }
  pieces.push(text.slice(cursor))
  return pieces.join("")
}

async function redact(texts) {
  if (!session) await load()
  lastUsed = Date.now()
  const document = texts.join(SEPARATOR)
  const spans = await spansFor(document)
  const out = []
  let offset = 0
  for (const text of texts) {
    const end = offset + text.length
    const local = spans
      .filter(([start, stop]) => Math.min(stop, end) > Math.max(start, offset))
      .map(([start, stop, label]) => [Math.max(start, offset) - offset, Math.min(stop, end) - offset, label])
    out.push(applySpans(text, local))
    offset = end + SEPARATOR.length
  }
  return out
}

function exclusive(task) {
  const result = queue.then(task, task)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function withWatchdog(task, ms = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.error("privacy-filter: request timed out, exiting for restart")
      process.exit(1)
    }, ms)
    task().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { ok: true, ready })
    return
  }
  if (request.method !== "POST" || request.url !== "/redact") {
    send(response, 404, { error: "not found" })
    return
  }
  const chunks = []
  let size = 0
  request.on("data", (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) {
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on("end", async () => {
    let texts
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      texts = payload.texts
      if (!Array.isArray(texts) || !texts.every((text) => typeof text === "string"))
        throw new Error("texts must be a list of strings")
      if (texts.length > MAX_TEXTS) throw new Error("too many texts")
    } catch (error) {
      send(response, 400, { error: String(error) })
      return
    }
    try {
      inFlight = true
      const redacted = await exclusive(() => withWatchdog(() => redact(texts)))
      inFlight = false
      lastUsed = Date.now()
      send(response, 200, { redacted })
    } catch (error) {
      inFlight = false
      lastUsed = Date.now()
      console.error(`privacy-filter: redaction failed: ${error}`)
      send(response, 500, { error: String(error) })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.error(`privacy-filter: listening on ${HOST}:${PORT}`)
  exclusive(async () => {
    await load()
    await redact(["warmup"])
  }).catch((error) => console.error(`privacy-filter: model load failed: ${error}`))
})

// Release the ONNX session when idle so the ORT thread pool cannot keep the
// CPU busy between requests. The next request reloads from the local cache.
setInterval(async () => {
  if (!session || inFlight) return
  if (Date.now() - lastUsed < IDLE_MS) return
  const current = session
  session = null
  ready = false
  try {
    await current.release()
  } catch (error) {
    console.error(`privacy-filter: session release failed: ${error}`)
  }
  console.error("privacy-filter: idle, session released")
}, Math.max(1_000, Math.min(15_000, IDLE_MS / 4))).unref()
