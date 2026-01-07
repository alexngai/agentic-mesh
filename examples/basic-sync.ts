#!/usr/bin/env npx ts-node
/**
 * Basic Sync Demo
 *
 * Demonstrates two peers syncing a shared Y.Map over Nebula mesh.
 *
 * Prerequisites:
 * 1. Nebula installed on both machines
 * 2. Nebula certificates configured
 * 3. Nebula tunnel running (nebula -config /path/to/config.yaml)
 *
 * Usage:
 *   # On machine A (alice):
 *   PEER_ID=alice NEBULA_IP=10.42.0.10 PEERS='[{"id":"bob","nebulaIp":"10.42.0.11"}]' npx ts-node examples/basic-sync.ts
 *
 *   # On machine B (bob):
 *   PEER_ID=bob NEBULA_IP=10.42.0.11 PEERS='[{"id":"alice","nebulaIp":"10.42.0.10"}]' npx ts-node examples/basic-sync.ts
 */

import * as readline from 'readline'
import { NebulaMesh, YjsSyncProvider, PeerConfig } from '../src'

// Configuration from environment
const PEER_ID = process.env.PEER_ID || 'peer-' + Math.random().toString(36).slice(2, 6)
const NEBULA_IP = process.env.NEBULA_IP || '127.0.0.1'
const PEERS: PeerConfig[] = JSON.parse(process.env.PEERS || '[]')
const PORT = parseInt(process.env.PORT || '7946', 10)

async function main() {
  console.log('='.repeat(60))
  console.log('agentic-mesh Basic Sync Demo')
  console.log('='.repeat(60))
  console.log(`Peer ID: ${PEER_ID}`)
  console.log(`Nebula IP: ${NEBULA_IP}`)
  console.log(`Port: ${PORT}`)
  console.log(`Known peers: ${PEERS.map((p) => p.id).join(', ') || '(none)'}`)
  console.log('='.repeat(60))

  // Create mesh
  const mesh = new NebulaMesh({
    peerId: PEER_ID,
    nebulaIp: NEBULA_IP,
    peers: PEERS,
    port: PORT,
  })

  // Listen for peer events
  mesh.on('peer:joined', (peer) => {
    console.log(`\n[MESH] Peer joined: ${peer.id} (${peer.nebulaIp})`)
  })

  mesh.on('peer:left', (peer) => {
    console.log(`\n[MESH] Peer left: ${peer.id}`)
  })

  // Connect to mesh
  console.log('\nConnecting to mesh...')
  try {
    await mesh.connect()
    console.log('[MESH] Connected!')
  } catch (err) {
    console.error('[MESH] Failed to connect:', err)
    process.exit(1)
  }

  // Create sync provider
  const provider = new YjsSyncProvider(mesh, {
    namespace: 'demo',
  })

  // Listen for sync events
  provider.on('syncing', () => {
    console.log('[SYNC] Syncing with peers...')
  })

  provider.on('synced', () => {
    console.log('[SYNC] Synced!')
  })

  provider.on('peer:synced', (peerId) => {
    console.log(`[SYNC] Synced with peer: ${peerId}`)
  })

  // Start sync
  console.log('\nStarting sync provider...')
  await provider.start()

  // Get shared map
  const shared = provider.getMap<string>('demo-data')

  // Watch for changes
  shared.observe((event) => {
    console.log('\n[DATA] Map changed:')
    for (const [key, value] of shared.entries()) {
      console.log(`  ${key}: ${value}`)
    }
  })

  // Interactive CLI
  console.log('\n' + '='.repeat(60))
  console.log('Commands:')
  console.log('  set <key> <value>  - Set a value in the shared map')
  console.log('  get <key>          - Get a value from the shared map')
  console.log('  list               - List all values in the shared map')
  console.log('  peers              - List connected peers')
  console.log('  quit               - Exit')
  console.log('='.repeat(60) + '\n')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `[${PEER_ID}]> `,
  })

  rl.prompt()

  rl.on('line', (line) => {
    const [cmd, ...args] = line.trim().split(/\s+/)

    switch (cmd.toLowerCase()) {
      case 'set':
        if (args.length >= 2) {
          const key = args[0]
          const value = args.slice(1).join(' ')
          shared.set(key, value)
          console.log(`Set ${key} = ${value}`)
        } else {
          console.log('Usage: set <key> <value>')
        }
        break

      case 'get':
        if (args.length >= 1) {
          const value = shared.get(args[0])
          console.log(`${args[0]} = ${value ?? '(not set)'}`)
        } else {
          console.log('Usage: get <key>')
        }
        break

      case 'list':
        console.log('Shared map contents:')
        if (shared.size === 0) {
          console.log('  (empty)')
        } else {
          for (const [key, value] of shared.entries()) {
            console.log(`  ${key}: ${value}`)
          }
        }
        break

      case 'peers':
        const peers = mesh.getPeers()
        console.log(`Connected peers (${peers.length}):`)
        for (const peer of peers) {
          console.log(`  ${peer.id} (${peer.nebulaIp}) - ${peer.status}`)
        }
        break

      case 'quit':
      case 'exit':
        console.log('Shutting down...')
        provider.stop().then(() => {
          mesh.disconnect().then(() => {
            process.exit(0)
          })
        })
        return

      case '':
        break

      default:
        console.log(`Unknown command: ${cmd}`)
    }

    rl.prompt()
  })

  rl.on('close', () => {
    console.log('\nShutting down...')
    provider.stop().then(() => {
      mesh.disconnect().then(() => {
        process.exit(0)
      })
    })
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
