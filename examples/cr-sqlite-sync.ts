#!/usr/bin/env npx ts-node
/**
 * CR-SQLite Sync Demo
 *
 * Demonstrates two peers syncing a shared SQLite database over Nebula mesh
 * using cr-sqlite for CRDT-based replication.
 *
 * Prerequisites:
 * 1. Nebula installed on both machines
 * 2. Nebula certificates configured
 * 3. Nebula tunnel running (nebula -config /path/to/config.yaml)
 * 4. cr-sqlite extension installed (see: npm run demo:cr-sqlite:install)
 *
 * Usage:
 *   # On machine A (alice):
 *   PEER_ID=alice NEBULA_IP=10.42.0.10 PEERS='[{"id":"bob","nebulaIp":"10.42.0.11"}]' npx ts-node examples/cr-sqlite-sync.ts
 *
 *   # On machine B (bob):
 *   PEER_ID=bob NEBULA_IP=10.42.0.11 PEERS='[{"id":"alice","nebulaIp":"10.42.0.10"}]' npx ts-node examples/cr-sqlite-sync.ts
 *
 * Commands:
 *   add <title>     - Add a new task
 *   done <id>       - Mark task as done
 *   list            - List all tasks
 *   status          - Show sync status
 *   quit            - Exit
 */

import * as readline from 'readline'
import * as path from 'path'
import * as fs from 'fs'
import { NebulaMesh, CrSqliteSyncProvider, PeerConfig, getInstallInstructions } from '../src'

// Configuration from environment
const PEER_ID = process.env.PEER_ID || 'peer-' + Math.random().toString(36).slice(2, 6)
const NEBULA_IP = process.env.NEBULA_IP || '127.0.0.1'
const PEERS: PeerConfig[] = JSON.parse(process.env.PEERS || '[]')
const PORT = parseInt(process.env.PORT || '7946', 10)
const DB_DIR = process.env.DB_DIR || './data'

async function main() {
  console.log('='.repeat(60))
  console.log('agentic-mesh CR-SQLite Sync Demo')
  console.log('='.repeat(60))
  console.log(`Peer ID: ${PEER_ID}`)
  console.log(`Nebula IP: ${NEBULA_IP}`)
  console.log(`Port: ${PORT}`)
  console.log(`Known peers: ${PEERS.map((p) => p.id).join(', ') || '(none)'}`)
  console.log('='.repeat(60))

  // Ensure data directory exists
  const dbPath = path.join(DB_DIR, `${PEER_ID}.db`)
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true })
  }

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
  let provider: CrSqliteSyncProvider
  try {
    provider = new CrSqliteSyncProvider(mesh, {
      namespace: 'tasks-db',
      dbPath,
      tables: ['tasks'],
      pollInterval: 100,
    })
  } catch (err) {
    console.error('\n[ERROR] Failed to create sync provider:', err)
    console.log('\n' + getInstallInstructions())
    process.exit(1)
  }

  // Listen for sync events
  provider.on('syncing', () => {
    console.log('[SYNC] Syncing with peers...')
  })

  provider.on('synced', () => {
    console.log('[SYNC] Initial sync complete!')
  })

  provider.on('change:applied', (table, pk) => {
    console.log(`[SYNC] Remote change applied: ${table}[${JSON.stringify(pk)}]`)
  })

  provider.on('change:sent', (table, count) => {
    console.log(`[SYNC] Sent ${count} changes for ${table}`)
  })

  provider.on('error', (err) => {
    console.error(`[SYNC] Error: ${err.message}`)
  })

  // Start sync
  console.log('\nStarting sync provider...')
  console.log(`Database: ${dbPath}`)
  try {
    await provider.start()
  } catch (err) {
    console.error('[SYNC] Failed to start:', err)
    console.log('\n' + getInstallInstructions())
    await mesh.disconnect()
    process.exit(1)
  }

  // Get database and create table
  const db = provider.getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_by TEXT,
      created_at INTEGER
    )
  `)

  console.log(`[DB] Site ID: ${provider.getSiteId()}`)
  console.log(`[DB] Local version: ${provider.getLocalVersion()}`)

  // Helper functions
  function generateId(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  function addTask(title: string): void {
    const id = generateId()
    db.prepare('INSERT INTO tasks (id, title, status, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, 'pending', PEER_ID, Date.now())
    console.log(`[DB] Added task: ${id} - ${title}`)
  }

  function completeTask(id: string): void {
    const result = db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('done', id)
    if (result.changes > 0) {
      console.log(`[DB] Completed task: ${id}`)
    } else {
      console.log(`[DB] Task not found: ${id}`)
    }
  }

  function listTasks(): void {
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Array<{
      id: string
      title: string
      status: string
      created_by: string
      created_at: number
    }>

    if (tasks.length === 0) {
      console.log('[DB] No tasks')
      return
    }

    console.log('\nTasks:')
    console.log('-'.repeat(60))
    for (const task of tasks) {
      const status = task.status === 'done' ? '[x]' : '[ ]'
      const date = new Date(task.created_at).toLocaleString()
      console.log(`  ${status} ${task.id}: ${task.title}`)
      console.log(`      by ${task.created_by} at ${date}`)
    }
    console.log('-'.repeat(60))
  }

  function showStatus(): void {
    console.log('\nSync Status:')
    console.log(`  Site ID: ${provider.getSiteId()}`)
    console.log(`  Local Version: ${provider.getLocalVersion()}`)
    console.log(`  Synced: ${provider.synced}`)
    console.log(`  Syncing: ${provider.syncing}`)

    const peerVersions = provider.getPeerVersions()
    if (peerVersions.size > 0) {
      console.log('  Peer Versions:')
      for (const [peerId, version] of peerVersions) {
        console.log(`    ${peerId}: ${version}`)
      }
    }
  }

  // Interactive CLI
  console.log('\n' + '='.repeat(60))
  console.log('Commands:')
  console.log('  add <title>  - Add a new task')
  console.log('  done <id>    - Mark task as done')
  console.log('  list         - List all tasks')
  console.log('  status       - Show sync status')
  console.log('  quit         - Exit')
  console.log('='.repeat(60))

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const prompt = () => {
    rl.question(`\n[${PEER_ID}]> `, async (input) => {
      const [cmd, ...args] = input.trim().split(/\s+/)

      switch (cmd?.toLowerCase()) {
        case 'add':
          if (args.length === 0) {
            console.log('Usage: add <title>')
          } else {
            addTask(args.join(' '))
          }
          break

        case 'done':
          if (args.length === 0) {
            console.log('Usage: done <id>')
          } else {
            completeTask(args[0])
          }
          break

        case 'list':
          listTasks()
          break

        case 'status':
          showStatus()
          break

        case 'quit':
        case 'exit':
        case 'q':
          console.log('Shutting down...')
          rl.close()
          await provider.stop()
          await mesh.disconnect()
          process.exit(0)
          break

        default:
          if (cmd) {
            console.log(`Unknown command: ${cmd}`)
            console.log('Commands: add, done, list, status, quit')
          }
      }

      prompt()
    })
  }

  prompt()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
