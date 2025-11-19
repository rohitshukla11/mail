#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { config as loadEnv } from 'dotenv'
import { JsonRpcProvider } from 'ethers'
import mime from 'mime-types'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import {
  appendEmailEntry,
  encryptEmail,
  ensureMailbox,
  fetchPublicKeyFromEns,
  synapseUpload,
  getMailboxUploadResult,
  persistMailbox,
  setMailboxUploadResult,
} from '@dmail/core'

loadEnv()

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('sendEmail')
    .option('to', {
      type: 'string',
      demandOption: true,
      describe: 'Recipient ENS name (e.g. bob.eth)',
    })
    .option('from', {
      type: 'string',
      describe: 'Sender ENS name (optional, overrides env DMAIL_FROM_ENS)',
    })
    .option('subject', {
      type: 'string',
      demandOption: true,
      describe: 'Email subject',
    })
    .option('body', {
      type: 'string',
      demandOption: true,
      describe: 'Email body/message',
    })
    .option('attachment', {
      type: 'array',
      describe: 'Attachment file paths',
    })
    .option('recipient-pubkey', {
      type: 'string',
      describe: 'Recipient public key override (hex). If omitted, ENS text record `dmail:pubkey` will be used.',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Perform encryption and upload but skip ENS updates',
    })
    .help()
    .parseAsync()

  const recipientEns = argv.to
  const subject = argv.subject
  const message = argv.body

  const senderEns = argv.from ?? process.env.DMAIL_FROM_ENS
  if (!senderEns) {
    throw new Error('Sender ENS name is required. Provide --from or set DMAIL_FROM_ENS.')
  }

  const rpcUrl = process.env.ETH_RPC_URL
  if (!rpcUrl) {
    throw new Error('ETH_RPC_URL is required to resolve ENS and submit transactions.')
  }

  const privateKey = process.env.WALLET_PRIVATE_KEY
  if (!privateKey) {
    throw new Error('WALLET_PRIVATE_KEY environment variable is required to sign ENS updates.')
  }

  const provider = new JsonRpcProvider(rpcUrl)

  const recipientPublicKey =
    argv['recipient-pubkey'] ??
    (await fetchPublicKeyFromEns(recipientEns, { provider })) ??
    process.env.RECIPIENT_PUBLIC_KEY

  if (!recipientPublicKey) {
    throw new Error(
      `Recipient public key not found. Set ENS text record dmail:pubkey for ${recipientEns} or provide --recipient-pubkey.`
    )
  }

  const currentMailboxUploadResult = await getMailboxUploadResult(recipientEns, { provider })
  const { mailbox, uploadResult: existingMailboxUploadResult } = await ensureMailbox(recipientEns, currentMailboxUploadResult, { provider })

  const attachments = await loadAttachments(argv.attachment ?? [])

  const encryptedEmail = await encryptEmail(
    {
      from: senderEns,
      to: recipientEns,
      subject,
      message,
      attachments,
      timestamp: Date.now(),
    },
    recipientPublicKey
  )

  const emailUpload = await synapseUpload(encryptedEmail, {
    filename: `email-${senderEns}-${Date.now()}.json`,
    metadata: {
      type: 'dmail-email',
      from: senderEns,
      to: recipientEns,
    },
  })

  const updatedMailbox = appendEmailEntry(mailbox, emailUpload, {
    from: senderEns,
    to: recipientEns,
    timestamp: encryptedEmail.timestamp,
    subjectPreview: subject.slice(0, 120),
  })

  const mailboxUpload = await persistMailbox(updatedMailbox, {
    owner: recipientEns,
    uploadOptions: {
      metadata: {
        type: 'dmail-mailbox',
        owner: recipientEns,
      },
    },
  })

  if (!argv['dry-run']) {
    await setMailboxUploadResult(recipientEns, mailboxUpload, {
      provider,
      privateKey,
      wait: true,
    })
  }

  console.log('✅ Email stored via Filecoin Onchain Cloud (Synapse)')
  console.log(`   Email CID: ${emailUpload.cid}`)
  console.log(`   Email Piece CID: ${emailUpload.pieceCid}`)
  console.log(`   Provider ID: ${emailUpload.providerInfo?.id}`)
  console.log(`   Mailbox CID: ${mailboxUpload.cid}`)
  console.log(`   Mailbox Piece CID: ${mailboxUpload.pieceCid}`)
  if (argv['dry-run']) {
    console.log('   (ENS update skipped due to --dry-run)')
  }
}

async function loadAttachments(attachmentPaths) {
  if (!Array.isArray(attachmentPaths) || attachmentPaths.length === 0) {
    return []
  }

  return Promise.all(
    attachmentPaths.map(async (attachmentPath) => {
      const absolutePath = path.resolve(String(attachmentPath))
      const bytes = await readFile(absolutePath)
      const mimeType = mime.lookup(absolutePath) || 'application/octet-stream'
      return {
        filename: path.basename(absolutePath),
        mimeType,
        data: bytes.toString('base64'),
      }
    })
  )
}

main().catch((error) => {
  console.error('❌ Failed to send email:', error.message ?? error)
  process.exit(1)
})
