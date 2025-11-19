#!/usr/bin/env node
import { config as loadEnv } from 'dotenv'
import { JsonRpcProvider } from 'ethers'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import {
  decryptEmail,
  synapseFetch,
  getMailboxUploadResult,
  loadMailboxFromCid,
} from '@dmail/core'

loadEnv()

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('readInbox')
    .option('ens', {
      type: 'string',
      describe: 'ENS name whose inbox should be read',
    })
    .option('private-key', {
      type: 'string',
      describe: 'Private key used for decrypting emails (hex). Defaults to WALLET_PRIVATE_KEY.',
    })
    .option('limit', {
      type: 'number',
      default: 10,
      describe: 'Maximum number of emails to read (most recent first)',
    })
    .option('include-encrypted', {
      type: 'boolean',
      default: false,
      describe: 'Include encrypted payload in the output',
    })
    .help()
    .parseAsync()

  const ensName = argv.ens ?? process.env.DMAIL_FROM_ENS
  if (!ensName) {
    throw new Error('ENS name is required. Provide --ens or set DMAIL_FROM_ENS.')
  }

  const privateKey = argv['private-key'] ?? process.env.WALLET_PRIVATE_KEY
  if (!privateKey) {
    throw new Error('Private key is required to decrypt inbox contents. Set WALLET_PRIVATE_KEY.')
  }

  const rpcUrl = process.env.ETH_RPC_URL
  if (!rpcUrl) {
    throw new Error('ETH_RPC_URL is required to resolve ENS.')
  }
  const provider = new JsonRpcProvider(rpcUrl)

  const mailboxUploadResult = await getMailboxUploadResult(ensName, { provider })
  if (!mailboxUploadResult || !mailboxUploadResult.cid) {
    console.log(`Inbox for ${ensName} is empty (no mailbox stored).`)
    return
  }
  
  if (!mailboxUploadResult.pieceCid || !mailboxUploadResult.serviceURL) {
    throw new Error('Mailbox stored without provider info. Cannot retrieve with Synapse-only mode.')
  }

  const mailbox = await loadMailboxFromCid(mailboxUploadResult, { optional: true })
  if (!mailbox || mailbox.emails.length === 0) {
    console.log(`Inbox for ${ensName} has no emails yet.`)
    return
  }

  const emails = [...mailbox.emails].reverse().slice(0, argv.limit)
  console.log(`📬 Loaded ${emails.length} email(s) for ${ensName}`)
  console.log(`   Mailbox CID: ${mailboxUploadResult.cid}`)
  console.log(`   Provider ID: ${mailboxUploadResult.providerId}`)
  console.log('')

  for (const entry of emails) {
    if (!entry.pieceCid || !entry.serviceURL) {
      console.warn(`⚠️  Skipping email ${entry.cid}: missing provider info`)
      continue
    }
    
    // Reconstruct providerInfo from entry
    const entryProviderInfo = {
      id: entry.providerId,
      address: entry.providerAddress,
      products: {
        PDP: {
          data: {
            serviceURL: entry.serviceURL
          }
        }
      }
    }
    
    const encryptedEmail = await synapseFetch(entry.cid, {
      as: 'json',
      pieceCid: entry.pieceCid,
      providerInfo: entryProviderInfo
    })
    const decrypted = await decryptEmail(encryptedEmail, privateKey)

    console.log('────────────────────────────────────────')
    console.log(`CID: ${entry.cid}`)
    console.log(`From: ${decrypted.from}`)
    console.log(`To: ${decrypted.to}`)
    console.log(`Timestamp: ${new Date(decrypted.timestamp).toISOString()}`)
    console.log(`Subject: ${decrypted.subject}`)
    console.log('')
    console.log(decrypted.message)

    if (Array.isArray(decrypted.attachments) && decrypted.attachments.length > 0) {
      console.log('')
      console.log(`Attachments (${decrypted.attachments.length}):`)
      decrypted.attachments.forEach((attachment, index) => {
        console.log(
          `  ${index + 1}. ${attachment.filename} (${attachment.mimeType}) — base64 length ${
            attachment.data?.length ?? 0
          }`
        )
      })
    }

    if (argv['include-encrypted']) {
      console.log('')
      console.log('Encrypted payload:')
      console.log(JSON.stringify(encryptedEmail, null, 2))
    }
  }
}

main().catch((error) => {
  console.error('❌ Failed to read inbox:', error.message ?? error)
  process.exit(1)
})

