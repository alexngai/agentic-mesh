#!/usr/bin/env npx ts-node
/**
 * ACP Mesh Integration Demo
 *
 * Demonstrates how to integrate the AcpMeshAdapter with an ACP server,
 * enabling cross-peer ACP communication over the Nebula mesh.
 *
 * This example shows:
 * 1. How to wire up ExampleAcpServer with AcpMeshAdapter
 * 2. How to handle incoming ACP requests from remote peers
 * 3. How to forward ACP requests to remote peers
 * 4. How to broadcast session updates across the mesh
 *
 * Prerequisites:
 * 1. Nebula installed and configured
 * 2. Nebula tunnel running
 *
 * Usage:
 *   # On machine A:
 *   PEER_ID=alice NEBULA_IP=10.42.0.10 PEERS='[{"id":"bob","nebulaIp":"10.42.0.11"}]' npx ts-node examples/acp-mesh-demo.ts
 *
 *   # On machine B:
 *   PEER_ID=bob NEBULA_IP=10.42.0.11 PEERS='[{"id":"alice","nebulaIp":"10.42.0.10"}]' npx ts-node examples/acp-mesh-demo.ts
 *
 * Implements: s-4hjr, i-7pxu
 */

import * as readline from 'readline'
import { NebulaMesh, AcpMeshAdapter, PeerConfig } from '../src'
import type { AcpRequest, AcpNotification } from '../src/acp/types'
import { isAcpRequest } from '../src/acp/types'
import { ExampleAcpServer } from './acp-server'

// =============================================================================
// Configuration
// =============================================================================

const PEER_ID = process.env.PEER_ID || 'peer-' + Math.random().toString(36).slice(2, 6)
const NEBULA_IP = process.env.NEBULA_IP || '127.0.0.1'
const PEERS: PeerConfig[] = JSON.parse(process.env.PEERS || '[]')
const PORT = parseInt(process.env.PORT || '7946', 10)

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('='.repeat(60))
  console.log('ACP Mesh Integration Demo')
  console.log('='.repeat(60))
  console.log(`Peer ID: ${PEER_ID}`)
  console.log(`Nebula IP: ${NEBULA_IP}`)
  console.log(`Port: ${PORT}`)
  console.log(`Known peers: ${PEERS.map((p) => p.id).join(', ') || '(none)'}`)
  console.log('='.repeat(60))

  // ---------------------------------------------------------------------------
  // Step 1: Create the mesh
  // ---------------------------------------------------------------------------
  console.log('\n[1] Creating mesh...')
  const mesh = new NebulaMesh({
    peerId: PEER_ID,
    nebulaIp: NEBULA_IP,
    peers: PEERS,
    port: PORT,
  })

  // Listen for peer events
  mesh.on('peer:joined', (peer) => {
    console.log(`[MESH] Peer joined: ${peer.id}`)
  })
  mesh.on('peer:left', (peer) => {
    console.log(`[MESH] Peer left: ${peer.id}`)
  })

  // ---------------------------------------------------------------------------
  // Step 2: Create the ACP adapter
  // ---------------------------------------------------------------------------
  console.log('[2] Creating ACP adapter...')
  const adapter = new AcpMeshAdapter(mesh)

  // ---------------------------------------------------------------------------
  // Step 3: Create the ACP server
  // ---------------------------------------------------------------------------
  console.log('[3] Creating ACP server...')
  const server = new ExampleAcpServer()

  // ---------------------------------------------------------------------------
  // Step 4: Wire up the integration
  // ---------------------------------------------------------------------------
  console.log('[4] Wiring up integration...')

  // 4a. Handle incoming ACP requests from remote peers
  adapter.onRequest(async (request, from, respond) => {
    console.log(`[ACP] Request from ${from.id}: ${request.method}`)

    // Process the request using our local ACP server
    const response = await server.handleRequest(request)
    console.log(`[ACP] Sending response to ${from.id}`)
    respond(response)
  })

  // 4b. Handle incoming ACP notifications from remote peers
  adapter.onMessage((message, from) => {
    if (!isAcpRequest(message)) {
      // It's a notification or response
      console.log(`[ACP] Notification from ${from.id}:`, JSON.stringify(message).slice(0, 100))
    }
  })

  // 4c. Broadcast session updates to all peers
  server.on('session:update', (notification: AcpNotification) => {
    console.log('[ACP] Broadcasting session update')
    adapter.broadcast(notification)
  })

  // ---------------------------------------------------------------------------
  // Step 5: Start everything
  // ---------------------------------------------------------------------------
  console.log('[5] Starting mesh and adapter...')
  await mesh.connect()
  await adapter.start()
  console.log('[OK] Mesh and adapter started\n')

  // ---------------------------------------------------------------------------
  // Interactive CLI
  // ---------------------------------------------------------------------------
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  console.log('Commands:')
  console.log('  peers              - List connected peers')
  console.log('  session            - Create a new session locally')
  console.log('  prompt <text>      - Send a prompt to local session')
  console.log('  remote <peer> <cmd> - Run command on remote peer')
  console.log('  read <peer> <path> - Read file from remote peer')
  console.log('  broadcast <msg>    - Broadcast notification to all peers')
  console.log('  quit               - Exit')
  console.log('')

  let currentSessionId: string | null = null

  const prompt = () => {
    rl.question(`[${PEER_ID}]> `, async (input) => {
      const [cmd, ...args] = input.trim().split(' ')

      try {
        switch (cmd) {
          case 'peers': {
            const peers = mesh.getPeers()
            if (peers.length === 0) {
              console.log('No connected peers')
            } else {
              peers.forEach((p) => {
                console.log(`  ${p.id} (${p.status}) - ${p.nebulaIp}`)
              })
            }
            break
          }

          case 'session': {
            const request: AcpRequest = {
              jsonrpc: '2.0',
              id: `req-${Date.now()}`,
              method: 'session/new',
              params: {},
            }
            const response = await server.handleRequest(request)
            if (response.result) {
              const result = response.result as { sessionId: string }
              currentSessionId = result.sessionId
              console.log(`Created session: ${currentSessionId}`)
            }
            break
          }

          case 'prompt': {
            if (!currentSessionId) {
              console.log('No session. Run "session" first.')
              break
            }
            const text = args.join(' ')
            const request: AcpRequest = {
              jsonrpc: '2.0',
              id: `req-${Date.now()}`,
              method: 'session/prompt',
              params: { sessionId: currentSessionId, content: text },
            }
            const response = await server.handleRequest(request)
            console.log('Response:', JSON.stringify(response.result, null, 2))
            break
          }

          case 'remote': {
            const [peerId, ...cmdParts] = args
            if (!peerId || cmdParts.length === 0) {
              console.log('Usage: remote <peer> <command>')
              break
            }
            const command = cmdParts.join(' ')
            console.log(`Sending terminal/create to ${peerId}...`)

            const request: AcpRequest = {
              jsonrpc: '2.0',
              id: `req-${Date.now()}`,
              method: 'terminal/create',
              params: { command },
            }

            try {
              const response = await adapter.request(peerId, request, 10000)
              console.log('Response:', JSON.stringify(response, null, 2))

              // Wait for exit
              if (response.result) {
                const { terminalId } = response.result as { terminalId: string }
                const waitRequest: AcpRequest = {
                  jsonrpc: '2.0',
                  id: `req-${Date.now()}`,
                  method: 'terminal/wait_for_exit',
                  params: { terminalId, timeout: 30000 },
                }
                const waitResponse = await adapter.request(peerId, waitRequest, 35000)
                console.log('Exit:', JSON.stringify(waitResponse, null, 2))

                // Get output
                const outputRequest: AcpRequest = {
                  jsonrpc: '2.0',
                  id: `req-${Date.now()}`,
                  method: 'terminal/output',
                  params: { terminalId },
                }
                const outputResponse = await adapter.request(peerId, outputRequest)
                const output = (outputResponse.result as { output: string })?.output
                console.log('Output:\n', output)
              }
            } catch (error) {
              console.log('Error:', error instanceof Error ? error.message : error)
            }
            break
          }

          case 'read': {
            const [peerId, filePath] = args
            if (!peerId || !filePath) {
              console.log('Usage: read <peer> <path>')
              break
            }
            console.log(`Reading ${filePath} from ${peerId}...`)

            const request: AcpRequest = {
              jsonrpc: '2.0',
              id: `req-${Date.now()}`,
              method: 'fs/read_text_file',
              params: { path: filePath },
            }

            try {
              const response = await adapter.request(peerId, request, 10000)
              if (response.error) {
                console.log('Error:', response.error.message)
              } else {
                const content = (response.result as { content: string })?.content
                console.log('Content:\n', content)
              }
            } catch (error) {
              console.log('Error:', error instanceof Error ? error.message : error)
            }
            break
          }

          case 'broadcast': {
            const message = args.join(' ') || 'Hello from ' + PEER_ID
            const notification: AcpNotification = {
              jsonrpc: '2.0',
              method: 'chat/message',
              params: { from: PEER_ID, message },
            }
            adapter.broadcast(notification)
            console.log('Broadcast sent')
            break
          }

          case 'quit':
          case 'exit':
            console.log('Shutting down...')
            await server.cleanup()
            await adapter.stop()
            await mesh.disconnect()
            rl.close()
            process.exit(0)
            break

          case '':
            break

          default:
            console.log(`Unknown command: ${cmd}`)
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error)
      }

      prompt()
    })
  }

  prompt()
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT. Exiting...')
  process.exit(0)
})

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
