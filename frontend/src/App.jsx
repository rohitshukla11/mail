import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  appendEmailEntry,
  decryptEmail,
  encryptEmail,
  fetchPublicKeyFromEns,
  fetchAttachment,
  synapseFetch,
  synapseUpload,
  getMailboxUploadResult,
  loadMailboxFromCid,
  persistMailbox,
  setMailboxUploadResult,
  createEmptyCalendar,
  appendCalendarEvent,
  loadCalendarFromCid as loadCalendarFromCidFile,
  persistCalendar,
  getCalendarUploadResult,
  setCalendarUploadResult,
  generateCalendarIcs,
} from '@dmail/core'

import CalendarSidebar from './components/calendar/CalendarSidebar'
import EventModal from './components/calendar/EventModal'

import './App.css'

const initialPrivateKey =
  import.meta.env.VITE_TEST_PRIVATE_KEY ?? import.meta.env.VITE_WALLET_PRIVATE_KEY ?? ''

const FALLBACK_SEPOLIA_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7'

function stringToBase64(value) {
  if (typeof window !== 'undefined' && window.btoa) {
    return window.btoa(unescape(encodeURIComponent(value)))
  }
  if (typeof globalThis !== 'undefined' && globalThis.Buffer) {
    return globalThis.Buffer.from(value, 'utf8').toString('base64')
  }
  throw new Error('Base64 encoding is not supported in this environment')
}

function App() {
  const [walletAddress, setWalletAddress] = useState(null)
  const [ensName, setEnsName] = useState(null)
  const [provider, setProvider] = useState(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [privateKey, setPrivateKey] = useState(initialPrivateKey)
  const [mailboxUploadResult, setMailboxUploadResultState] = useState(null)
  const [mailboxEntries, setMailboxEntries] = useState([])
  const [loadingInbox, setLoadingInbox] = useState(false)
  const [selectedEmail, setSelectedEmail] = useState(null)
  const [sending, setSending] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  const [activeView, setActiveView] = useState('inbox')
  const [searchQuery, setSearchQuery] = useState('')
  const [calendarFullPage, setCalendarFullPage] = useState(false)
  const [fetchingPubKey, setFetchingPubKey] = useState(false)
  const [pubKeyFetchError, setPubKeyFetchError] = useState(null)
  const [showManualPubKey, setShowManualPubKey] = useState(false)
  const [composeState, setComposeState] = useState({
    to: '',
    subject: '',
    message: '',
    recipientPublicKey: '',
    attachments: [],
  })
  const [calendarEvents, setCalendarEvents] = useState([])
  const [calendarUploadResult, setCalendarUploadResultState] = useState(null)
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState('')
  const [showEventModal, setShowEventModal] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)

  const sepoliaRpcUrl = useMemo(
    () =>
      import.meta.env.VITE_ETH_RPC_URL ??
      import.meta.env.VITE_SEPOLIA_RPC_URL ??
      FALLBACK_SEPOLIA_RPC_URL,
    []
  )

  const ensureSepoliaChain = useCallback(async () => {
    if (!window.ethereum?.request) {
      throw new Error('MetaMask (window.ethereum) not available for ENS operations.')
    }
    const currentChainId = await window.ethereum.request({ method: 'eth_chainId' })
    if (currentChainId === SEPOLIA_CHAIN_ID_HEX) {
      return false
    }
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
      })
      return true
    } catch (switchError) {
      if (switchError?.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: SEPOLIA_CHAIN_ID_HEX,
              chainName: 'Sepolia test network',
              nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: [sepoliaRpcUrl],
              blockExplorerUrls: ['https://sepolia.etherscan.io/'],
            },
          ],
        })
        return true
      }
      throw new Error('Please switch MetaMask to the Sepolia testnet before sending mail.')
    }
  }, [sepoliaRpcUrl])

  const ensureProvider = useCallback(async () => {
    if (!window.ethereum) {
      throw new Error('MetaMask (window.ethereum) not available')
    }
    const switched = await ensureSepoliaChain()
    if (!provider || switched) {
      const { BrowserProvider } = await import('ethers')
      const browserProvider = new BrowserProvider(window.ethereum)
      setProvider(browserProvider)
      return browserProvider
    }
    return provider
  }, [provider, ensureSepoliaChain])

  // Create a Sepolia provider specifically for ENS resolution
  const getEnsProvider = useCallback(async () => {
    const { JsonRpcProvider } = await import('ethers')
    return new JsonRpcProvider(sepoliaRpcUrl)
  }, [sepoliaRpcUrl])

  // Function to resolve ENS name for current address
  const resolveEnsName = useCallback(
    async (address) => {
      if (!address) return null

      try {
        // Use Sepolia provider for ENS resolution (ENS names are on Sepolia testnet)
        const ensProvider = await getEnsProvider()
        console.log('Resolving ENS on Sepolia for address:', address)
        
        const name = await ensProvider.lookupAddress(address)
        console.log('ENS reverse lookup result:', name)
        
        if (name) {
          // Verify forward resolution
          try {
            const resolvedAddress = await ensProvider.resolveName(name)
            if (resolvedAddress && resolvedAddress.toLowerCase() === address.toLowerCase()) {
              console.log('✓ ENS name verified:', name, '->', resolvedAddress)
              return name
            } else {
              console.warn('⚠ ENS forward resolution mismatch:', name, 'resolved to', resolvedAddress, 'expected', address)
              return name // Still return it, just warn
            }
          } catch (verifyError) {
            console.warn('⚠ Failed to verify ENS name:', verifyError)
            return name // Still return it if reverse lookup worked
          }
        } else {
          console.warn('⚠ No reverse ENS record found for:', address)
          return null
        }
      } catch (error) {
        console.error('❌ Failed to lookup ENS name:', error)
        return null
      }
    },
    [getEnsProvider]
  )

  // Listen for account changes and re-resolve ENS
  useEffect(() => {
    if (!window.ethereum || !walletAddress) return

    const handleAccountsChanged = async (accounts) => {
      if (accounts.length > 0 && accounts[0] !== walletAddress) {
        console.log('Account changed to:', accounts[0])
        const newAddress = accounts[0]
        setWalletAddress(newAddress)
        
        // Resolve ENS name using Sepolia provider
        const name = await resolveEnsName(newAddress)
        setEnsName(name)
      } else if (accounts.length === 0) {
        console.log('Wallet disconnected')
        setWalletAddress(null)
        setEnsName(null)
      }
    }

    window.ethereum.on('accountsChanged', handleAccountsChanged)

    return () => {
      window.ethereum?.removeListener('accountsChanged', handleAccountsChanged)
    }
  }, [walletAddress, resolveEnsName])

  const connectWallet = useCallback(async () => {
    try {
      setErrorMessage('')
      const browserProvider = await ensureProvider()
      const accounts = await browserProvider.send('eth_requestAccounts', [])
      const address = accounts?.[0]
      if (!address) throw new Error('No accounts returned from provider')
      setWalletAddress(address)
      
      // Resolve ENS name using Sepolia provider (ENS names are on Sepolia testnet)
      const resolvedName = await resolveEnsName(address)
      setEnsName(resolvedName)
      
      // Don't show toast - status is shown in navbar
      return browserProvider
    } catch (error) {
      console.error(error)
      setErrorMessage(error.message ?? 'Failed to connect wallet')
      return null
    }
  }, [ensureProvider, resolveEnsName])

  const updateCompose = (changes) => {
    setComposeState((prev) => ({
      ...prev,
      ...changes,
    }))
  }

  // Auto-fetch public key from ENS when recipient changes
  const fetchRecipientPublicKey = useCallback(
    async (ensName) => {
      if (!ensName || !ensName.endsWith('.eth')) {
        setPubKeyFetchError(null)
        setShowManualPubKey(false)
        updateCompose({ recipientPublicKey: '' })
        return
      }

      setFetchingPubKey(true)
      setPubKeyFetchError(null)
      setShowManualPubKey(false)

      try {
        const ensProvider = await getEnsProvider()
        const publicKey = await fetchPublicKeyFromEns(ensName, { provider: ensProvider })
        
        if (publicKey) {
          updateCompose({ recipientPublicKey: publicKey })
          setPubKeyFetchError(null)
        } else {
          setPubKeyFetchError(`No public key found for ${ensName}. Recipient needs to set dmail:pubkey in ENS.`)
          setShowManualPubKey(true)
          updateCompose({ recipientPublicKey: '' })
        }
      } catch (error) {
        console.warn('Failed to fetch public key from ENS:', error)
        setPubKeyFetchError(`Could not fetch public key for ${ensName}. You can enter it manually.`)
        setShowManualPubKey(true)
        updateCompose({ recipientPublicKey: '' })
      } finally {
        setFetchingPubKey(false)
      }
    },
    [getEnsProvider]
  )

  const refreshInbox = useCallback(async () => {
    setLoadingInbox(true)
    setErrorMessage('')
    try {
      await ensureProvider()
      const ensProvider = await getEnsProvider()
      const targetEns =
        ensName ?? (walletAddress ? await ensProvider.lookupAddress(walletAddress) : null)
      const mailboxUploadResult = await getMailboxUploadResult(targetEns ?? walletAddress, {
        provider: ensProvider,
      })
      setMailboxUploadResultState(mailboxUploadResult)
      if (!mailboxUploadResult || !mailboxUploadResult.cid) {
        setMailboxEntries([])
        setStatusMessage('No mailbox found for this account yet')
        return
      }
      
      if (!mailboxUploadResult.pieceCid || !mailboxUploadResult.serviceURL) {
        throw new Error('Mailbox stored without provider info. Cannot retrieve with Synapse-only mode.')
      }
      
      const mailbox = await loadMailboxFromCid(mailboxUploadResult, { optional: true })
      setMailboxEntries(mailbox?.emails?.slice().reverse() ?? [])
      setStatusMessage(`Loaded ${mailbox?.emails?.length ?? 0} email(s)`)
    } catch (error) {
      console.error(error)
      setErrorMessage(error.message ?? 'Failed to load inbox')
    } finally {
      setLoadingInbox(false)
    }
  }, [ensureProvider, ensName, getEnsProvider, walletAddress])

  const refreshCalendar = useCallback(async () => {
    if (!walletAddress && !ensName) return

    setCalendarLoading(true)
    setCalendarError('')
    try {
      const ensProvider = await getEnsProvider()
      await ensureProvider()
      const targetEns =
        ensName ?? (walletAddress ? await ensProvider.lookupAddress(walletAddress) : null)
      if (!targetEns) {
        setCalendarEvents([])
        setCalendarUploadResultState(null)
        return
      }

      const uploadResult = await getCalendarUploadResult(targetEns, { provider: ensProvider })
      setCalendarUploadResultState(uploadResult ?? null)

      if (!uploadResult?.cid || !uploadResult?.pieceCid) {
        setCalendarEvents([])
        return
      }

      const calendar = await loadCalendarFromCidFile(uploadResult, { optional: true })
      setCalendarEvents(calendar?.events ?? [])
    } catch (error) {
      console.error(error)
      setCalendarError(error.message ?? 'Failed to load calendar')
    } finally {
      setCalendarLoading(false)
    }
  }, [walletAddress, ensName, getEnsProvider, ensureProvider])

  useEffect(() => {
    if (!walletAddress && !ensName) return
    void refreshInbox()
  }, [walletAddress, ensName, refreshInbox])

  useEffect(() => {
    if (!walletAddress && !ensName) return
    void refreshCalendar()
  }, [walletAddress, ensName, refreshCalendar])

  const openEmail = useCallback(
    async (entry) => {
      setSelectedEmail(null)
      setErrorMessage('')
      if (!privateKey) {
        setErrorMessage('Private key required to decrypt emails')
        return
      }
      try {
        // Reconstruct providerInfo from entry
        if (!entry.pieceCid || !entry.serviceURL) {
          throw new Error('Email entry missing provider info. Cannot retrieve with Synapse-only mode.')
        }
        const providerInfo = {
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
        const encryptedPayload = await synapseFetch(entry.cid, {
          as: 'json',
          pieceCid: entry.pieceCid,
          providerInfo
        })
        // Decrypt email and fetch attachments from Synapse
        const decrypted = await decryptEmail(encryptedPayload, privateKey, {
          fetchAttachmentsFromSynapse: true
        })
        setSelectedEmail({
          entry,
          decrypted,
          encrypted: encryptedPayload,
        })
      } catch (error) {
        console.error(error)
        setErrorMessage(error.message ?? 'Failed to decrypt email. Check private key.')
      }
    },
    [privateKey]
  )

  const handleAttachments = async (event) => {
    const files = Array.from(event.target.files ?? [])
    const attachments = await Promise.all(
      files.map(async (file) => ({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: await readFileAsBase64(file),
      }))
    )
    updateCompose({ attachments })
  }

  const handleShareEvent = useCallback(
    (event) => {
      if (!event) return
      const organizer = ensName ?? walletAddress ?? 'dmail-user'
      const ics = generateCalendarIcs(event, organizer)
      setComposeState({
        to: '',
        subject: `[Invite] ${event.title}`,
        message: `You're invited to ${event.title} on ${new Date(event.startTime).toLocaleString()}${
          event.location ? ` at ${event.location}` : ''
        }.\n\n${event.description ?? ''}`,
        attachments: [
          {
            filename: `${event.title || 'event'}.ics`,
            mimeType: 'text/calendar',
            data: stringToBase64(ics),
          },
        ],
        recipientPublicKey: '',
      })
      setShowCompose(true)
    },
    [ensName, walletAddress]
  )

  const handleDownloadAttachment = useCallback(async (attachment) => {
    try {
      if (!attachment) {
        throw new Error('Attachment is missing')
      }

      let attachmentData = attachment

      // If attachment needs to be fetched from Synapse, fetch it first
      if (attachment._needsFetch && attachment.cid && attachment.pieceCid && privateKey) {
        setStatusMessage('Fetching attachment from storage...')
        try {
          attachmentData = await fetchAttachment(
            {
              cid: attachment.cid,
              pieceCid: attachment.pieceCid,
              providerInfo: attachment.providerInfo,
              encryptedMetadata: attachment.encryptedMetadata,
            },
            privateKey
          )
          // Update the attachment in the selected email to cache it
          if (selectedEmail?.decrypted?.attachments) {
            const updatedAttachments = selectedEmail.decrypted.attachments.map((att) =>
              att.cid === attachment.cid ? attachmentData : att
            )
            setSelectedEmail({
              ...selectedEmail,
              decrypted: {
                ...selectedEmail.decrypted,
                attachments: updatedAttachments,
              },
            })
          }
        } catch (fetchError) {
          console.error('Failed to fetch attachment from Synapse:', fetchError)
          throw new Error(`Failed to fetch attachment: ${fetchError.message}`)
        }
      }

      if (!attachmentData.data) {
        throw new Error('Attachment data is missing')
      }

      // Decode base64 data
      const base64Data = attachmentData.data
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }

      // Create blob from bytes
      const blob = new Blob([bytes], { type: attachmentData.mimeType || 'application/octet-stream' })

      // Create download link
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = attachmentData.filename || 'attachment'
      document.body.appendChild(link)
      link.click()

      // Cleanup
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setStatusMessage('')
    } catch (error) {
      console.error('Failed to download attachment:', error)
      setErrorMessage(`Failed to download attachment: ${error.message}`)
      setStatusMessage('')
    }
  }, [privateKey, selectedEmail])

  const handleSaveEvent = useCallback(
    async (eventInput) => {
      setSavingEvent(true)
      setCalendarError('')
      try {
        const ensProvider = await getEnsProvider()
        const browserProvider = (await ensureProvider()) ?? provider
        const signer = await browserProvider.getSigner()
        const ownerEns = ensName ?? (walletAddress ? await ensProvider.lookupAddress(walletAddress) : null)
        if (!ownerEns) {
          throw new Error('ENS name not resolved for calendar')
        }

        let calendarData = null
        if (calendarUploadResult?.cid && calendarUploadResult?.pieceCid) {
          calendarData = await loadCalendarFromCidFile(calendarUploadResult, { optional: true })
        }
        if (!calendarData) {
          calendarData = createEmptyCalendar(ownerEns)
        }

        const updatedCalendar = appendCalendarEvent(calendarData, eventInput)
        const uploadResult = await persistCalendar(updatedCalendar, {
          owner: ownerEns,
          uploadOptions: {
            metadata: {
              type: 'dmail-calendar',
              owner: ownerEns,
            },
          },
        })

        await setCalendarUploadResult(ownerEns, uploadResult, { signer, wait: true })
        setCalendarUploadResultState(uploadResult)
        setCalendarEvents(updatedCalendar.events)
        setShowEventModal(false)
      } catch (error) {
        console.error(error)
        setCalendarError(error.message ?? 'Failed to save event')
      } finally {
        setSavingEvent(false)
      }
    },
    [calendarUploadResult, ensName, ensureProvider, getEnsProvider, provider, walletAddress]
  )

  const handleSend = useCallback(
    async (event) => {
      event?.preventDefault()
      setSending(true)
      setErrorMessage('')
      setStatusMessage('Encrypting email...')
      try {
        const browserProvider = (await ensureProvider()) ?? provider
        const ensProvider = await getEnsProvider()
        const signer = await browserProvider.getSigner()
        const senderEns =
          ensName ?? (walletAddress ? await ensProvider.lookupAddress(walletAddress) : null)

        if (!senderEns) {
          throw new Error('ENS name not resolved for connected wallet. Set one or use CLI.')
        }

        const recipientEns = composeState.to
        if (!recipientEns) {
          throw new Error('Recipient ENS name is required')
        }

        const recipientPublicKey =
          composeState.recipientPublicKey ||
          (await fetchPublicKeyFromEns(recipientEns, { provider: ensProvider })) ||
          import.meta.env.VITE_RECIPIENT_PUBLIC_KEY

        if (!recipientPublicKey) {
          throw new Error(
            `Recipient public key missing. Set ENS text record dmail:pubkey for ${recipientEns} or provide VITE_RECIPIENT_PUBLIC_KEY.`
          )
        }

        const timestamp = Date.now()
        
        // Upload attachments to Synapse if any
        if (composeState.attachments.length > 0) {
          setStatusMessage(`Uploading ${composeState.attachments.length} attachment(s) to Filecoin storage...`)
        }
        
        const encryptedEmail = await encryptEmail(
          {
            from: senderEns,
            to: recipientEns,
            subject: composeState.subject,
            message: composeState.message,
            attachments: composeState.attachments,
            timestamp,
          },
          recipientPublicKey,
          {
            uploadAttachmentsToSynapse: true, // Explicitly enable Synapse upload for attachments
          }
        )

        setStatusMessage('Uploading encrypted email to Filecoin storage...')
        const emailUpload = await synapseUpload(encryptedEmail, {
          filename: `email-${senderEns}-${timestamp}.json`,
          metadata: {
            type: 'dmail-email',
            from: senderEns,
            to: recipientEns,
          },
        })

        setStatusMessage('Updating mailbox index...')
        const currentMailboxUploadResult =
          mailboxUploadResult ??
          (await getMailboxUploadResult(recipientEns, {
            provider: ensProvider,
          }))
        
        let mailbox
        if (currentMailboxUploadResult && currentMailboxUploadResult.cid && currentMailboxUploadResult.pieceCid) {
          mailbox = await loadMailboxFromCid(currentMailboxUploadResult, { optional: true })
        }
        
        if (!mailbox) {
          mailbox = {
            owner: recipientEns,
            version: 1,
            updatedAt: new Date().toISOString(),
            emails: [],
          }
        }

        const updatedMailbox = appendEmailEntry(mailbox, emailUpload, {
          from: senderEns,
          to: recipientEns,
          timestamp,
          subjectPreview: composeState.subject.slice(0, 120),
        })

        const nextMailboxUploadResult = await persistMailbox(updatedMailbox, {
          owner: recipientEns,
          uploadOptions: {
            metadata: {
              type: 'dmail-mailbox',
              owner: recipientEns,
            },
          },
        })

        await setMailboxUploadResult(recipientEns, nextMailboxUploadResult, {
          signer,
          wait: true,
        })

        setStatusMessage('Email sent successfully!')
        updateCompose({ to: '', subject: '', message: '', recipientPublicKey: '', attachments: [] })
        setPubKeyFetchError(null)
        setShowManualPubKey(false)
        setFetchingPubKey(false)
        setShowCompose(false)
        setMailboxUploadResultState(nextMailboxUploadResult)
        await refreshInbox()
      } catch (error) {
        console.error(error)
        setErrorMessage(error.message ?? 'Failed to send email')
      } finally {
        setSending(false)
      }
    },
    [
      composeState.attachments,
      composeState.message,
      composeState.recipientPublicKey,
      composeState.subject,
      composeState.to,
      ensureProvider,
      ensName,
      mailboxUploadResult,
      provider,
      refreshInbox,
      walletAddress,
      getEnsProvider,
    ]
  )

  const filteredEmails = useMemo(() => {
    if (!searchQuery) return mailboxEntries
    const query = searchQuery.toLowerCase()
    return mailboxEntries.filter(
      (entry) =>
        entry.from?.toLowerCase().includes(query) ||
        entry.subjectPreview?.toLowerCase().includes(query)
    )
  }, [mailboxEntries, searchQuery])

  const formatTime = (timestamp) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now - date
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    
    if (days === 0) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    } else if (days < 7) {
      return date.toLocaleDateString('en-US', { weekday: 'short' })
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
  }

  return (
    <div className="gmail-layout">
      {/* Header */}
      <header className="gmail-header">
        <div className="header-left">
          <button className="menu-btn" aria-label="Menu">☰</button>
          <h1 className="logo">
            <span className="logo-icon">📧</span>
            dMail
          </h1>
        </div>
        
        <div className="header-center">
          <div className="search-bar">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Search mail"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="header-right">
          {walletAddress ? (
            <div className="wallet-status">
              <span className="wallet-indicator connected">●</span>
              <span className="user-info" title={walletAddress}>
                {ensName || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`}
              </span>
            </div>
          ) : (
            <>
              <button className="icon-btn" onClick={connectWallet} title="Connect Wallet">
                🔌
              </button>
              <span className="user-info">Not connected</span>
            </>
          )}
        </div>
      </header>

      {/* Status Messages - filter out wallet connection status since it's in navbar */}
      {statusMessage && statusMessage !== 'Wallet connected' && (
        <div className="toast toast-success">{statusMessage}</div>
      )}
      {errorMessage && <div className="toast toast-error">{errorMessage}</div>}

      <div className="gmail-container">
        {/* Sidebar */}
        <aside className={`gmail-sidebar ${calendarFullPage ? 'hidden' : ''}`}>
          <button
            className="compose-btn"
            onClick={() => setShowCompose(true)}
            disabled={!walletAddress}
          >
            <span className="compose-icon">✏️</span>
            Compose
          </button>

          <nav className="sidebar-nav">
            <button
              className={activeView === 'inbox' ? 'nav-item active' : 'nav-item'}
              onClick={() => setActiveView('inbox')}
            >
              <span className="nav-icon">📥</span>
              <span className="nav-label">Inbox</span>
              <span className="nav-count">{mailboxEntries.length}</span>
            </button>
            <button className="nav-item" onClick={() => alert('Not implemented')}>
              <span className="nav-icon">⭐</span>
              <span className="nav-label">Starred</span>
            </button>
            <button className="nav-item" onClick={() => alert('Not implemented')}>
              <span className="nav-icon">📤</span>
              <span className="nav-label">Sent</span>
            </button>
            <button className="nav-item" onClick={() => alert('Not implemented')}>
              <span className="nav-icon">📝</span>
              <span className="nav-label">Drafts</span>
            </button>
          </nav>

          <div className="sidebar-footer">
            <button className="text-btn" onClick={refreshInbox} disabled={!walletAddress || loadingInbox}>
              {loadingInbox ? '⏳ Loading...' : '🔄 Refresh'}
            </button>
            <div className="private-key-section">
              <label className="key-label">
                🔐 Private Key
                <span className="key-hint" title="Required to decrypt your encrypted emails. This key stays in your browser only.">
                  ℹ️
                </span>
              </label>
              <input
                type="password"
                className="key-input"
                placeholder="0x... (required for decryption)"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                title="Enter your wallet's private key to decrypt emails. This is required because emails are encrypted with your public key."
              />
              <div className="key-help">
                <small>
                  ℹ️ Why needed? Emails are encrypted with your public key. You need your private key to decrypt them. MetaMask doesn't expose private keys for security.
                </small>
              </div>
            </div>
          </div>
        </aside>

        {/* Email List */}
        <main className={`gmail-main ${calendarFullPage ? 'hidden' : ''}`}>
          <div className="toolbar">
            <div className="toolbar-left">
              <input type="checkbox" className="select-all" />
              <button className="toolbar-btn" title="Refresh" onClick={refreshInbox}>
                ↻
              </button>
            </div>
          </div>

          <div className="email-list">
            {loadingInbox ? (
              <div className="empty-state">Loading inbox...</div>
            ) : filteredEmails.length === 0 ? (
              <div className="empty-state">
                {searchQuery ? 'No emails match your search' : 'Your inbox is empty'}
              </div>
            ) : (
              filteredEmails.map((entry) => (
                <div
                  key={entry.cid}
                  className={`email-item ${selectedEmail?.entry.cid === entry.cid ? 'active' : ''}`}
                  onClick={() => openEmail(entry)}
                >
                  <input type="checkbox" className="email-checkbox" onClick={(e) => e.stopPropagation()} />
                  <span className="email-star">☆</span>
                  <span className="email-sender">{entry.from || 'Unknown'}</span>
                  <span className="email-subject">
                    {entry.subjectPreview || '(No subject)'}
                  </span>
                  <span className="email-time">{formatTime(entry.timestamp)}</span>
                </div>
              ))
            )}
          </div>
        </main>

        {/* Email Viewer */}
        <section className={`gmail-viewer ${selectedEmail && !calendarFullPage ? 'open' : ''}`}>
          {selectedEmail ? (
            <div className="email-detail">
              <div className="email-header">
                <h2 className="email-title">{selectedEmail.decrypted.subject}</h2>
                <div className="email-actions">
                  <button className="icon-btn" title="Reply">↩️</button>
                  <button className="icon-btn" title="Archive">🗄️</button>
                  <button className="icon-btn" title="Delete">🗑️</button>
                  <button className="icon-btn" onClick={() => setSelectedEmail(null)} title="Close">
                    ✕
                  </button>
                </div>
              </div>

              <div className="email-meta">
                <div className="sender-info">
                  <div className="sender-avatar">{selectedEmail.decrypted.from?.[0]?.toUpperCase() || '?'}</div>
                  <div className="sender-details">
                    <div className="sender-name">{selectedEmail.decrypted.from}</div>
                    <div className="sender-email">to {selectedEmail.decrypted.to}</div>
                  </div>
                </div>
                <div className="email-timestamp">
                  {new Date(selectedEmail.decrypted.timestamp).toLocaleString()}
                </div>
              </div>

              <div className="email-body">
                <pre>{selectedEmail.decrypted.message}</pre>
              </div>

              {Array.isArray(selectedEmail.decrypted.attachments) &&
                selectedEmail.decrypted.attachments.length > 0 && (
                  <div className="email-attachments">
                    <div className="attachments-header">📎 {selectedEmail.decrypted.attachments.length} attachment(s)</div>
                    <div className="attachments-list">
                      {selectedEmail.decrypted.attachments.map((attachment, idx) => (
                        <div
                          key={idx}
                          className="attachment-item"
                          onClick={() => handleDownloadAttachment(attachment)}
                          title="Click to download"
                        >
                          <span className="attachment-icon">📄</span>
                          <span className="attachment-name">{attachment.filename}</span>
                          <span className="attachment-size">({attachment.mimeType})</span>
                          <span className="attachment-download">⬇</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          ) : (
            <div className="empty-viewer">
              <div className="empty-icon">📭</div>
              <p>Select an email to read</p>
            </div>
          )}
        </section>

        <CalendarSidebar
          events={calendarEvents}
          loading={calendarLoading}
          error={calendarError}
          onRefresh={refreshCalendar}
          onAddEvent={() => setShowEventModal(true)}
          onShareEvent={handleShareEvent}
          fullPage={calendarFullPage}
          onToggleFullPage={() => setCalendarFullPage(!calendarFullPage)}
        />
      </div>

      {/* Compose Modal */}
      {showCompose && (
        <div
          className="compose-modal-overlay"
          onClick={() => {
            setShowCompose(false)
            // Reset state when modal closes
            setPubKeyFetchError(null)
            setShowManualPubKey(false)
            setFetchingPubKey(false)
          }}
        >
          <div className="compose-modal" onClick={(e) => e.stopPropagation()}>
            <div className="compose-header">
              <h3>New Message</h3>
              <button
                className="close-btn"
                onClick={() => {
                  setShowCompose(false)
                  // Reset state when modal closes
                  setPubKeyFetchError(null)
                  setShowManualPubKey(false)
                  setFetchingPubKey(false)
                }}
              >
                ✕
              </button>
            </div>

            <form className="compose-form" onSubmit={handleSend}>
              <div className="compose-field">
                <input
                  type="text"
                  placeholder="To (ENS name, e.g. alice.eth)"
                  value={composeState.to}
                  onChange={(e) => {
                    const ensName = e.target.value.trim()
                    updateCompose({ to: ensName })
                    // Auto-fetch public key when ENS name is entered
                    if (ensName && ensName.endsWith('.eth')) {
                      fetchRecipientPublicKey(ensName)
                    } else {
                      setPubKeyFetchError(null)
                      setShowManualPubKey(false)
                      updateCompose({ recipientPublicKey: '' })
                    }
                  }}
                  onBlur={(e) => {
                    // Also try fetching on blur if not already fetched
                    const ensName = e.target.value.trim()
                    if (ensName && ensName.endsWith('.eth') && !composeState.recipientPublicKey) {
                      fetchRecipientPublicKey(ensName)
                    }
                  }}
                  required
                />
                {fetchingPubKey && (
                  <div className="field-status">🔍 Looking up public key from ENS...</div>
                )}
                {composeState.recipientPublicKey && !fetchingPubKey && !pubKeyFetchError && (
                  <div className="field-status success">✓ Public key found and loaded</div>
                )}
                {pubKeyFetchError && (
                  <div className="field-status error">{pubKeyFetchError}</div>
                )}
              </div>

              {(showManualPubKey || composeState.recipientPublicKey) && (
                <div className="compose-field">
                  <input
                    type="text"
                    placeholder="Recipient Public Key (optional override)"
                    value={composeState.recipientPublicKey}
                    onChange={(e) => {
                      updateCompose({ recipientPublicKey: e.target.value })
                      // If user manually enters a key, clear error
                      if (e.target.value) {
                        setPubKeyFetchError(null)
                      }
                    }}
                  />
                  <div className="field-help">
                    <small>
                      ℹ️ Only needed if ENS lookup failed. Usually auto-filled from {composeState.to || 'recipient'} ENS record.
                    </small>
                  </div>
                </div>
              )}

              <div className="compose-field">
                <input
                  type="text"
                  placeholder="Subject"
                  value={composeState.subject}
                  onChange={(e) => updateCompose({ subject: e.target.value })}
                  required
                />
              </div>

              <div className="compose-body">
                <textarea
                  placeholder="Message"
                  value={composeState.message}
                  onChange={(e) => updateCompose({ message: e.target.value })}
                  required
                />
              </div>

              {composeState.attachments.length > 0 && (
                <div className="compose-attachments">
                  {composeState.attachments.map((attachment, idx) => (
                    <div key={idx} className="compose-attachment">
                      📎 {attachment.filename}
                    </div>
                  ))}
                </div>
              )}

              <div className="compose-footer">
                <button type="submit" className="send-btn" disabled={sending}>
                  {sending ? '⏳ Sending...' : '📤 Send'}
        </button>
                <label className="attach-btn">
                  📎 Attach
                  <input type="file" multiple onChange={handleAttachments} style={{ display: 'none' }} />
                </label>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEventModal && (
        <EventModal onClose={() => setShowEventModal(false)} onSave={handleSaveEvent} saving={savingEvent} />
      )}
      </div>
  )
}

async function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        const base64 = result.split(',').pop()
        resolve(base64 ?? '')
      } else {
        resolve('')
      }
    }
    reader.onerror = (error) => reject(error)
    reader.readAsDataURL(file)
  })
}

export default App
