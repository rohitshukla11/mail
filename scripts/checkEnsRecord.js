#!/usr/bin/env node

/**
 * Script to check if ENS text record is set correctly
 * 
 * Usage:
 *   node scripts/checkEnsRecord.js <ens-name> <record-key>
 *   
 * Example:
 *   node scripts/checkEnsRecord.js rohit.eth dmail:pubkey
 */

import { ethers } from 'ethers'
import dotenv from 'dotenv'

dotenv.config()

const ensName = process.argv[2]
const recordKey = process.argv[3] || 'dmail:pubkey'

if (!ensName) {
  console.error('Usage: node scripts/checkEnsRecord.js <ens-name> [record-key]')
  console.error('Example: node scripts/checkEnsRecord.js rohit.eth dmail:pubkey')
  process.exit(1)
}

const rpcUrl = process.env.ETH_RPC_URL || process.env.VITE_ETH_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'

async function checkEnsRecord() {
  try {
    console.log('\n🔍 Checking ENS Record')
    console.log('─'.repeat(60))
    console.log(`ENS Name:       ${ensName}`)
    console.log(`Record Key:     ${recordKey}`)
    console.log(`RPC URL:        ${rpcUrl}`)
    console.log()

    const provider = new ethers.JsonRpcProvider(rpcUrl)
    
    // Check if ENS name resolves
    console.log('1. Resolving ENS name to address...')
    const address = await provider.resolveName(ensName)
    if (!address) {
      console.error(`❌ ENS name ${ensName} does not resolve to an address`)
      console.error('   Make sure the name exists on Sepolia testnet')
      process.exit(1)
    }
    console.log(`   ✓ Resolved to: ${address}`)

    // Check resolver
    console.log('\n2. Checking resolver...')
    const resolver = await provider.getResolver(ensName)
    if (!resolver) {
      console.error(`❌ No resolver configured for ${ensName}`)
      console.error('\n   To fix this:')
      console.error('   1. Go to https://app.ens.domains/')
      console.error('   2. Select your ENS name')
      console.error('   3. Go to "Resolver" section')
      console.error('   4. Set a resolver if none is set')
      process.exit(1)
    }
    const resolverAddress = await resolver.getAddress()
    console.log(`   ✓ Resolver found: ${resolverAddress}`)
    
    // Check if resolver is the same as resolved address (self-resolver)
    if (resolverAddress.toLowerCase() === address.toLowerCase()) {
      console.warn('\n   ⚠️  WARNING: Resolver address equals resolved address')
      console.warn('   This might be a self-resolver setup.')
      console.warn('   Self-resolvers may not support text records properly.')
    }

    // Check text record
    console.log(`\n3. Checking text record "${recordKey}"...`)
    
    // Try different key formats in case there's a formatting issue
    const keyVariations = [recordKey, recordKey.toLowerCase(), recordKey.replace(':', '_')]
    
    let value = null
    for (const key of keyVariations) {
      try {
        const testValue = await resolver.getText(key)
        if (testValue && testValue.trim().length > 0) {
          console.log(`   Found with key variation: "${key}"`)
          value = testValue
          break
        }
      } catch (e) {
        // Continue to next variation
      }
    }
    
    // Try the exact key
    if (!value) {
      try {
        value = await resolver.getText(recordKey)
      } catch (error) {
        console.warn(`   Error fetching text record: ${error.message}`)
      }
    }
    
    if (!value || value.trim().length === 0) {
      console.error(`❌ Text record "${recordKey}" not found on-chain`)
      console.error('\n   Transaction was confirmed but record not found.')
      console.error('   Possible issues:')
      console.error('   1. Self-resolver may not support text records')
      console.error('   2. Wrong resolver contract - may need to set proper resolver')
      console.error('   3. Record key format issue - check if key is exactly "dmail:pubkey"')
      console.error('\n   Checking transaction details...')
      console.error(`   Please check transaction on Etherscan:`)
      console.error(`   https://sepolia.etherscan.io/address/${resolverAddress}`)
      console.error('\n   To set this record:')
      console.error('   1. Go to https://app.ens.domains/')
      console.error(`   2. Select "${ensName}"`)
      console.error('   3. Click "Records" tab')
      console.error('   4. Click "Add Record" or "+"')
      console.error(`   5. Key: ${recordKey}`)
      console.error('   6. Value: <your public key>')
      console.error('   7. Save and confirm transaction in MetaMask')
      console.error('   8. Wait for transaction confirmation (check Etherscan)')
      process.exit(1)
    }

    console.log(`   ✓ Record found!`)
    console.log(`   Value: ${value}`)
    
    // Validate public key format
    if (recordKey === 'dmail:pubkey') {
      if (!value.startsWith('0x04')) {
        console.warn('\n   ⚠️  Warning: Public key should start with 0x04 (uncompressed format)')
      }
      if (value.length !== 132) {
        console.warn(`   ⚠️  Warning: Expected 132 characters, got ${value.length}`)
      } else {
        console.log('   ✓ Public key format looks correct')
      }
    }

    // Reverse lookup to verify
    console.log('\n4. Verifying reverse lookup...')
    const reverseName = await provider.lookupAddress(address)
    if (reverseName && reverseName.toLowerCase() === ensName.toLowerCase()) {
      console.log(`   ✓ Reverse lookup works: ${address} → ${reverseName}`)
    } else {
      console.warn(`   ⚠️  Reverse lookup: ${address} → ${reverseName || 'none'}`)
      console.warn('      (This is optional - primary name may not be set)')
    }

    console.log('\n✅ All checks passed!')
    console.log(`\n   Your ENS record "${recordKey}" is set correctly.`)
    console.log('   dMail should be able to fetch it now.\n')

  } catch (error) {
    console.error('\n❌ Error:', error.message)
    if (error.message.includes('network')) {
      console.error('\n   Make sure you are using Sepolia RPC URL')
      console.error(`   Current RPC: ${rpcUrl}`)
    }
    process.exit(1)
  }
}

checkEnsRecord()

