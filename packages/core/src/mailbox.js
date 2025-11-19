import { synapseFetch, synapseUpload } from './synapse.js'

export function createEmptyMailbox(ownerEns) {
  return {
    owner: ownerEns ?? null,
    version: 1,
    updatedAt: new Date().toISOString(),
    emails: [],
  }
}

export function appendEmailEntry(mailbox, emailUploadResult, metadata = {}) {
  if (!mailbox) {
    throw new Error('appendEmailEntry: mailbox is required')
  }
  if (!emailUploadResult || !emailUploadResult.cid) {
    throw new Error('appendEmailEntry: emailUploadResult with cid is required')
  }
  if (!emailUploadResult.pieceCid) {
    throw new Error('appendEmailEntry: emailUploadResult must include pieceCid for Synapse retrieval')
  }
  if (!emailUploadResult.providerInfo) {
    throw new Error('appendEmailEntry: emailUploadResult must include providerInfo for Synapse retrieval')
  }

  const entry = {
    cid: emailUploadResult.cid,
    pieceCid: emailUploadResult.pieceCid,
    providerId: emailUploadResult.providerInfo?.id,
    providerAddress: emailUploadResult.providerInfo?.address,
    serviceURL: emailUploadResult.providerInfo?.products?.PDP?.data?.serviceURL,
    timestamp: metadata.timestamp ?? Date.now(),
    from: metadata.from ?? null,
    to: metadata.to ?? null,
    subjectPreview: metadata.subjectPreview ?? null,
  }

  const emails = Array.isArray(mailbox.emails) ? [...mailbox.emails, entry] : [entry]
  return {
    ...mailbox,
    updatedAt: new Date().toISOString(),
    emails,
  }
}

export async function loadMailboxFromCid(mailboxUploadResult, options = {}) {
  if (!mailboxUploadResult || !mailboxUploadResult.cid) {
    if (options.optional) return null
    throw new Error('loadMailboxFromCid: mailboxUploadResult with cid is required')
  }
  
  if (!mailboxUploadResult.pieceCid) {
    if (options.optional) return null
    throw new Error('loadMailboxFromCid: mailboxUploadResult must include pieceCid for Synapse retrieval')
  }
  
  // Reconstruct providerInfo if not present but we have the components
  let providerInfo = mailboxUploadResult.providerInfo
  if (!providerInfo && mailboxUploadResult.serviceURL) {
    providerInfo = {
      id: mailboxUploadResult.providerId,
      address: mailboxUploadResult.providerAddress,
      products: {
        PDP: {
          data: {
            serviceURL: mailboxUploadResult.serviceURL
          }
        }
      }
    }
  }
  
  if (!providerInfo) {
    if (options.optional) return null
    throw new Error('loadMailboxFromCid: mailboxUploadResult must include providerInfo (or serviceURL) for Synapse retrieval')
  }

  try {
    const mailbox = await synapseFetch(mailboxUploadResult.cid, {
      as: 'json',
      pieceCid: mailboxUploadResult.pieceCid,
      providerInfo,
      ...options,
    })
    if (!mailbox || typeof mailbox !== 'object') {
      throw new Error('Mailbox payload is not a valid object')
    }
    if (!Array.isArray(mailbox.emails)) {
      mailbox.emails = []
    }
    return mailbox
  } catch (error) {
    if (options.optional) {
      return null
    }
    throw error
  }
}

export async function ensureMailbox(ensName, currentMailboxUploadResult, options = {}) {
  const existingMailbox = currentMailboxUploadResult
    ? await loadMailboxFromCid(currentMailboxUploadResult, { ...options, optional: true })
    : null

  if (existingMailbox) {
    return { mailbox: existingMailbox, uploadResult: currentMailboxUploadResult }
  }

  const mailbox = createEmptyMailbox(ensName)
  const uploadResult = await persistMailbox(mailbox, options)
  return { mailbox, uploadResult }
}

export async function persistMailbox(mailbox, options = {}) {
  if (!mailbox) {
    throw new Error('persistMailbox: mailbox is required')
  }
  const payload = JSON.stringify(mailbox, null, 2)
  const uploadResult = await synapseUpload(payload, {
    filename: options.filename ?? 'mailbox.json',
    metadata: {
      type: 'mailbox',
      owner: mailbox.owner ?? options.owner ?? 'unknown',
    },
    ...options.uploadOptions,
  })
  return uploadResult
}

