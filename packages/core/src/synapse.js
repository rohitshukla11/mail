import pino from 'pino'
import { Synapse } from '@filoz/synapse-sdk'

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null
const DEFAULT_RPC_URL = 'https://api.calibration.node.glif.io/rpc/v1'
const isBrowser = typeof window !== 'undefined'

let synapsePromise = null
let storageContextPromise = null
let loggerInstance = null

function getLogger() {
  if (!loggerInstance) {
    loggerInstance = pino({
      level: getEnv('FILECOIN_LOG_LEVEL') ?? 'info',
      browser: { asObject: true },
    })
  }
  return loggerInstance
}

function getEnv(name) {
  if (typeof process !== 'undefined' && process?.env?.[name]) {
    return process.env[name]
  }
  if (typeof import.meta !== 'undefined' && import.meta?.env) {
    const direct = import.meta.env[name]
    if (direct) return direct
    const prefixed = import.meta.env[`VITE_${name}`]
    if (prefixed) return prefixed
  }
  if (isBrowser && window?.__DMAIL_CONFIG__?.[name]) {
    return window.__DMAIL_CONFIG__[name]
  }
  return undefined
}

function parseBoolean(value) {
  if (value == null) return undefined
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return undefined
}

function parseInteger(value) {
  if (value == null || value === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function toUint8Array(data) {
  if (data == null) throw new Error('synapseUpload: data is required')
  if (data instanceof Uint8Array) return data
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (typeof data === 'string') {
    if (!textEncoder) throw new Error('synapseUpload: TextEncoder unavailable')
    return textEncoder.encode(data)
  }
  if (typeof data === 'object') {
    if (!textEncoder) throw new Error('synapseUpload: TextEncoder unavailable')
    return textEncoder.encode(JSON.stringify(data))
  }
  throw new Error(`synapseUpload: Unsupported data type ${typeof data}`)
}

function resolveSynapseOptions() {
  const rpcURL = getEnv('FILECOIN_RPC_URL') ?? DEFAULT_RPC_URL
  const warmStorageAddress = getEnv('FILECOIN_WARM_STORAGE_ADDRESS')
  const privateKey = getEnv('FILECOIN_PRIVATE_KEY') ?? getEnv('VITE_FILECOIN_PRIVATE_KEY')
  const sessionKey =
    getEnv('FILECOIN_SESSION_KEY') ?? getEnv('VITE_FILECOIN_SESSION_KEY') ?? getEnv('VITE_SESSION_KEY')

  if (privateKey) {
    return { privateKey, rpcURL, warmStorageAddress }
  }

  if (sessionKey) {
    return { privateKey: sessionKey, rpcURL, warmStorageAddress }
  }

  throw new Error('Synapse authentication missing. Provide FILECOIN_PRIVATE_KEY or FILECOIN_SESSION_KEY.')
}

function resolveStorageOptions() {
  const options = {}

  const providerId = parseInteger(getEnv('FILECOIN_PROVIDER_ID'))
  if (providerId) options.providerId = providerId

  const providerAddress = getEnv('FILECOIN_PROVIDER_ADDRESS')
  if (providerAddress) options.providerAddress = providerAddress

  const datasetId = parseInteger(getEnv('FILECOIN_DATASET_ID'))
  if (datasetId) options.dataSetId = datasetId

  const forceCreate = parseBoolean(getEnv('FILECOIN_DATASET_CREATE_NEW'))
  if (forceCreate) options.forceCreateDataSet = true

  const metadata = {}
  const owner = getEnv('FILECOIN_DATASET_OWNER')
  if (owner) metadata.owner = owner
  const namespace = getEnv('FILECOIN_DATASET_NAMESPACE')
  if (namespace) metadata.namespace = namespace

  if (Object.keys(metadata).length > 0) {
    options.metadata = metadata
  }

  return options
}

async function getSynapse() {
  if (!synapsePromise) {
    const options = resolveSynapseOptions()
    synapsePromise = Synapse.create({
      privateKey: options.privateKey,
      rpcURL: options.rpcURL,
      warmStorageAddress: options.warmStorageAddress,
      telemetry: {
        sentrySetTags: {
          appName: getEnv('FILECOIN_APP_NAME') ?? 'dmail-app',
        },
      },
    })
  }
  return synapsePromise
}

async function getStorageContext() {
  if (!storageContextPromise) {
    const synapse = await getSynapse()
    const storageOptions = resolveStorageOptions()
    storageContextPromise = synapse.storage.createContext(storageOptions)
  }
  return storageContextPromise
}

function normalizeMetadata(metadata = {}) {
  const normalized = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (value == null) continue
    normalized[key] = String(value)
  }
  return normalized
}

export async function synapseUpload(data, options = {}) {
  const payload = await toUint8Array(data)
  const filename = options.filename ?? `dmail-${Date.now()}.json`
  const contentType = options.contentType ?? 'application/json'

  const context = await getStorageContext()
  const uploadResult = await context.upload(payload, {
    metadata: normalizeMetadata({
      filename,
      contentType,
      ...options.metadata,
    }),
  })

  return {
    cid: uploadResult.pieceCid.toString(),
    pieceCid: uploadResult.pieceCid.toString(),
    providerInfo: context.provider,
    dataSetId: context.dataSetId ?? null,
    result: uploadResult,
  }
}

export async function synapseFetch(pieceCid, options = {}) {
  if (!pieceCid) throw new Error('synapseFetch: pieceCid is required')

  const providerInfo = options.providerInfo
  const providerUrl = providerInfo?.products?.PDP?.data?.serviceURL
  if (!providerUrl) {
    throw new Error('synapseFetch: providerInfo with PDP serviceURL is required')
  }

  const piece = options.pieceCid ?? pieceCid
  const url = `${providerUrl.replace(/\/$/, '')}/piece/${piece}`
  const response = await fetch(url)

  if (!response.ok) {
    const text = await safeReadText(response)
    throw new Error(`Synapse fetch failed (${response.status} ${response.statusText}): ${text}`)
  }

  return await parseResponse(response, options.as)
}

async function parseResponse(response, responseType = 'json') {
  if (responseType === 'arrayBuffer') {
    return await response.arrayBuffer()
  }
  if (responseType === 'text') {
    return await response.text()
  }
  try {
    return await response.json()
  } catch (error) {
    if (responseType === 'json') {
      throw new Error(
        `Synapse fetch expected JSON but parsing failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    throw error
  }
}

async function safeReadText(response) {
  try {
    return await response.text()
  } catch (error) {
    return `<unable to read body: ${error instanceof Error ? error.message : String(error)}>`
  }
}

export function decodeBytesToString(bytes) {
  if (!bytes) return ''
  if (typeof bytes === 'string') return bytes
  if (bytes instanceof Uint8Array) {
    if (!textDecoder) throw new Error('TextDecoder not available to decode data')
    return textDecoder.decode(bytes)
  }
  if (typeof ArrayBuffer !== 'undefined' && bytes instanceof ArrayBuffer) {
    if (!textDecoder) throw new Error('TextDecoder not available to decode data')
    return textDecoder.decode(new Uint8Array(bytes))
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
    return bytes.toString('utf8')
  }
  throw new Error('Unsupported byte-like input for decodeBytesToString')
}
