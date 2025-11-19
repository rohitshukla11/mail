#!/usr/bin/env node

/**
 * Helper script to derive a public encryption key from a private key
 * 
 * Usage:
 *   node scripts/derivePublicKey.js <private-key>
 *   
 * Or set ETH_PRIVATE_KEY environment variable:
 *   ETH_PRIVATE_KEY=0x... node scripts/derivePublicKey.js
 */

import EthCrypto from 'eth-crypto'
import { ethers } from 'ethers'

const privateKey = process.argv[2] || process.env.ETH_PRIVATE_KEY

if (!privateKey) {
  console.error('Usage: node scripts/derivePublicKey.js <private-key>')
  console.error('   or: ETH_PRIVATE_KEY=0x... node scripts/derivePublicKey.js')
  process.exit(1)
}

try {
  // Validate private key
  if (!ethers.isHexString(privateKey, 32)) {
    throw new Error('Invalid private key format. Must be a hex string starting with 0x and 64 characters long.')
  }

  // Create wallet to get address
  const wallet = new ethers.Wallet(privateKey)
  const address = wallet.address

  console.log('\n🔑 Public Key Derivation')
  console.log('─'.repeat(60))
  console.log(`Address:        ${address}`)
  
  // Use eth-crypto to derive public key (same method used by dMail)
  // This ensures compatibility with ECIES encryption
  const normalizedKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
  const publicKey = EthCrypto.publicKeyByPrivateKey(normalizedKey)
  console.log(`Public Key:     ${publicKey}`)
  
  if (!publicKey.startsWith('0x04')) {
    console.error('\n⚠️  Warning: Public key should start with 0x04 (uncompressed format)')
    console.error('   This key may not work with dMail encryption.')
  }

  console.log('\n📋 Instructions:')
  console.log('─'.repeat(60))
  console.log('1. Copy the Public Key above')
  console.log('2. Go to https://app.ens.domains/')
  console.log('3. Select your ENS name')
  console.log('4. Go to "Records" → "Add Record" → "Text Record"')
  console.log('5. Set Key: dmail:pubkey')
  console.log('6. Set Value: (paste the public key)')
  console.log('7. Save the transaction\n')
  
} catch (error) {
  console.error('\n❌ Error:', error.message)
  console.error('\nMake sure:')
  console.error('  - Private key starts with 0x')
  console.error('  - Private key is 66 characters long (0x + 64 hex chars)')
  console.error('  - Private key is valid hex format\n')
  process.exit(1)
}

