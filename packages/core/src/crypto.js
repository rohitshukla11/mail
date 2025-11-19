import EthCrypto from 'eth-crypto'

import { getEnsTextRecord } from './ens.js'
import { synapseUpload, synapseFetch } from './synapse.js'

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null

function normaliseHex(input) {
  if (!input) return undefined
  return input.startsWith('0x') ? input.slice(2) : input
}

function ensurePrivateKey(privateKey) {
  const key = normaliseHex(privateKey)
  if (!key) {
    throw new Error('Private key is required for this operation')
  }
  return key
}

export async function derivePublicKeyFromEthAddress(address, options = {}) {
  if (!address) {
    throw new Error('derivePublicKeyFromEthAddress: address is required')
  }

  if (options.privateKey) {
    return EthCrypto.publicKeyByPrivateKey(ensurePrivateKey(options.privateKey))
  }

  if (options.publicKey) {
    return normaliseHex(options.publicKey)
  }

  if (options.provider || options.resolver) {
    const publicKey = await getEnsTextRecord(address, 'dmail:pubkey', options)
    if (publicKey) {
      return normaliseHex(publicKey)
    }
  }

  throw new Error(
    'Unable to derive public key. Provide the recipient public key via options.publicKey, options.privateKey, or ENS text record `dmail:pubkey`.'
  )
}

/**
 * Upload attachments to Synapse SDK and return attachment references
 * @param {Array} attachments - Array of attachment objects with {filename, mimeType, data}
 * @param {string} recipientPublicKey - Public key to encrypt attachment metadata
 * @returns {Promise<Array>} Array of attachment references with {filename, mimeType, cid, pieceCid, providerInfo}
 */
export async function uploadAttachments(attachments, recipientPublicKey) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return []
  }

  const normalizedKey = normaliseHex(recipientPublicKey)
  if (!normalizedKey) {
    throw new Error('uploadAttachments: recipientPublicKey is required')
  }

  return Promise.all(
    attachments.map(async (attachment) => {
      if (!attachment?.data) {
        throw new Error('uploadAttachments: attachment data is required')
      }

      // Decode base64 data to binary
      const binaryData = decodeBase64Attachment(attachment.data)

      // Upload attachment to Synapse
      const uploadResult = await synapseUpload(binaryData, {
        filename: attachment.filename || 'attachment',
        contentType: attachment.mimeType || 'application/octet-stream',
        metadata: {
          type: 'dmail-attachment',
          filename: attachment.filename || 'attachment',
          mimeType: attachment.mimeType || 'application/octet-stream',
        },
      })

      // Encrypt attachment metadata (filename, mimeType) for privacy
      const encryptedMetadata = await encryptString(
        JSON.stringify({
          filename: attachment.filename || 'attachment',
          mimeType: attachment.mimeType || 'application/octet-stream',
        }),
        normalizedKey
      )

      return {
        cid: uploadResult.cid,
        pieceCid: uploadResult.pieceCid,
        providerInfo: uploadResult.providerInfo,
        encryptedMetadata, // Encrypted filename and mimeType
      }
    })
  )
}

/**
 * Fetch and decrypt attachment from Synapse SDK
 * @param {Object} attachmentRef - Attachment reference with {cid, pieceCid, providerInfo, encryptedMetadata}
 * @param {string} privateKey - Private key to decrypt attachment metadata
 * @returns {Promise<Object>} Attachment object with {filename, mimeType, data}
 */
export async function fetchAttachment(attachmentRef, privateKey) {
  if (!attachmentRef?.cid || !attachmentRef?.pieceCid) {
    throw new Error('fetchAttachment: attachment reference must include cid and pieceCid')
  }

  const normalizedKey = ensurePrivateKey(privateKey)

  // Fetch attachment from Synapse
  const encryptedData = await synapseFetch(attachmentRef.cid, {
    as: 'arrayBuffer',
    pieceCid: attachmentRef.pieceCid,
    providerInfo: attachmentRef.providerInfo,
  })

  // Convert ArrayBuffer to Uint8Array
  const bytes = encryptedData instanceof ArrayBuffer 
    ? new Uint8Array(encryptedData)
    : encryptedData instanceof Uint8Array
    ? encryptedData
    : new Uint8Array(0)

  // Decode to base64 for storage
  const base64Data = encodeAttachmentToBase64(bytes)

  // Decrypt metadata
  let metadata
  if (attachmentRef.encryptedMetadata) {
    const decryptedMetadata = await decryptString(attachmentRef.encryptedMetadata, normalizedKey)
    metadata = JSON.parse(decryptedMetadata)
  } else {
    // Fallback for old format (backward compatibility)
    metadata = {
      filename: attachmentRef.filename || 'attachment',
      mimeType: attachmentRef.mimeType || 'application/octet-stream',
    }
  }

  return {
    filename: metadata.filename || 'attachment',
    mimeType: metadata.mimeType || 'application/octet-stream',
    data: base64Data,
  }
}

export async function encryptEmail(payload, recipientPublicKey, options = {}) {
  if (!recipientPublicKey) {
    throw new Error('encryptEmail: recipientPublicKey is required')
  }
  if (!payload) {
    throw new Error('encryptEmail: payload is required')
  }

  const normalizedKey = normaliseHex(recipientPublicKey)
  const timestamp = payload.timestamp ?? Date.now()

  const encryptedSubject = await encryptString(payload.subject ?? '', normalizedKey)
  const encryptedMessage = await encryptString(payload.message ?? '', normalizedKey)

  // Handle attachments: either upload to Synapse (new way) or encrypt inline (old way for backward compatibility)
  let encryptedAttachments = []
  if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    if (options.uploadAttachmentsToSynapse !== false) {
      // New way: upload attachments to Synapse and store references
      const attachmentRefs = await uploadAttachments(payload.attachments, recipientPublicKey)
      encryptedAttachments = attachmentRefs
    } else {
      // Old way: encrypt attachments inline (for backward compatibility)
      encryptedAttachments = await Promise.all(
        payload.attachments.map(async (attachment) => {
          const data = attachment?.data ?? ''
          return {
            filename: attachment?.filename ?? 'attachment',
            mimeType: attachment?.mimeType ?? 'application/octet-stream',
            data: await encryptString(data, normalizedKey),
            _inline: true, // Flag to indicate inline encrypted data
          }
        })
      )
    }
  }

  return {
    fromEns: payload.from,
    toEns: payload.to,
    timestamp,
    encryptedSubject,
    encryptedMessage,
    encryptedAttachments,
  }
}

export async function decryptEmail(encryptedPayload, privateKey, options = {}) {
  if (!encryptedPayload) {
    throw new Error('decryptEmail: encryptedPayload is required')
  }
  const normalizedKey = ensurePrivateKey(privateKey)

  const subject = await decryptString(encryptedPayload.encryptedSubject ?? '', normalizedKey)
  const message = await decryptString(encryptedPayload.encryptedMessage ?? '', normalizedKey)

  // Handle attachments: either fetch from Synapse (new way) or decrypt inline (old way)
  let attachments = []
  if (Array.isArray(encryptedPayload.encryptedAttachments) && encryptedPayload.encryptedAttachments.length > 0) {
    attachments = await Promise.all(
      encryptedPayload.encryptedAttachments.map(async (attachment) => {
        // Check if this is an inline encrypted attachment (old format)
        if (attachment._inline || attachment.data) {
          // Old format: decrypt inline encrypted data
          return {
            filename: attachment.filename || 'attachment',
            mimeType: attachment.mimeType || 'application/octet-stream',
            data: await decryptString(attachment.data ?? '', normalizedKey),
          }
        } else if (attachment.cid && attachment.pieceCid) {
          // New format: fetch from Synapse
          if (options.fetchAttachmentsFromSynapse !== false) {
            return await fetchAttachment(attachment, privateKey)
          } else {
            // Return metadata only if fetching is disabled
            return {
              filename: 'attachment',
              mimeType: 'application/octet-stream',
              data: '', // Will be fetched on demand
              cid: attachment.cid,
              pieceCid: attachment.pieceCid,
              providerInfo: attachment.providerInfo,
              _needsFetch: true,
            }
          }
        } else {
          // Fallback: return what we have
          return {
            filename: attachment.filename || 'attachment',
            mimeType: attachment.mimeType || 'application/octet-stream',
            data: '',
          }
        }
      })
    )
  }

  return {
    from: encryptedPayload.fromEns ?? encryptedPayload.from,
    to: encryptedPayload.toEns ?? encryptedPayload.to,
    timestamp: encryptedPayload.timestamp,
    subject,
    message,
    attachments,
  }
}

async function encryptString(value, publicKey) {
  let stringValue
  if (typeof value === 'string') {
    stringValue = value
  } else if (value instanceof Uint8Array) {
    stringValue = encodeAttachmentToBase64(value)
  } else if (typeof value === 'object') {
    stringValue = JSON.stringify(value)
  } else {
    stringValue = String(value ?? '')
  }

  const cipherObject = await EthCrypto.encryptWithPublicKey(publicKey, stringValue)
  return EthCrypto.cipher.stringify(cipherObject)
}

async function decryptString(value, privateKey) {
  if (!value) return ''
  const cipherObject = EthCrypto.cipher.parse(value)
  const decrypted = await EthCrypto.decryptWithPrivateKey(privateKey, cipherObject)
  return decrypted
}

export function encodeAttachmentToBase64(bytes) {
  if (!bytes) return ''
  if (typeof bytes === 'string') return bytes

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) {
    return bytes.toString('base64')
  }

  if (bytes instanceof Uint8Array) {
    if (typeof btoa !== 'undefined') {
      let binary = ''
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte)
      })
      return btoa(binary)
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64')
    }
  }

  throw new Error('Unsupported attachment input for base64 encoding')
}

export function decodeBase64Attachment(encoded) {
  if (!encoded) return new Uint8Array()
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(encoded, 'base64'))
  }
  if (typeof atob !== 'undefined') {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  throw new Error('Base64 decoding is not supported in this environment')
}
