#!/usr/bin/env tsx
/**
 * Sudocode Loopback Test
 *
 * Demonstrates two SudocodeMeshService instances syncing on localhost.
 * No actual Nebula required - uses loopback addresses with different ports.
 *
 * Usage:
 *   npx tsx examples/sudocode-loopback.ts
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { NebulaMesh, SudocodeMeshService, SpecCRDT, IssueCRDT } from '../src'

// Test directories
const tmpDir = path.join(os.tmpdir(), 'agentic-mesh-test-' + Date.now())
const projectA = path.join(tmpDir, 'project-a')
const projectB = path.join(tmpDir, 'project-b')

async function setup() {
  console.log('Setting up test directories...')
  console.log(`  Project A: ${projectA}`)
  console.log(`  Project B: ${projectB}`)

  // Create project directories
  await fs.mkdir(path.join(projectA, 'mesh'), { recursive: true })
  await fs.mkdir(path.join(projectB, 'mesh'), { recursive: true })

  // Create empty JSONL files
  await fs.writeFile(path.join(projectA, 'specs.jsonl'), '')
  await fs.writeFile(path.join(projectA, 'issues.jsonl'), '')
  await fs.writeFile(path.join(projectB, 'specs.jsonl'), '')
  await fs.writeFile(path.join(projectB, 'issues.jsonl'), '')
}

async function cleanup() {
  console.log('\nCleaning up...')
  await fs.rm(tmpDir, { recursive: true, force: true })
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  await setup()

  console.log('\n=== Sudocode Loopback Sync Test ===\n')

  // Create two mesh instances on localhost
  console.log('Creating mesh instances...')

  const serviceA = new SudocodeMeshService({
    projectId: 'test-project',
    projectPath: projectA,
    meshConfig: {
      peerId: 'peer-a',
      nebulaIp: '127.0.0.1',
      port: 17946,
      peers: [{ id: 'peer-b', nebulaIp: '127.0.0.1', port: 17947 }],
    },
  })

  const serviceB = new SudocodeMeshService({
    projectId: 'test-project',
    projectPath: projectB,
    meshConfig: {
      peerId: 'peer-b',
      nebulaIp: '127.0.0.1',
      port: 17947,
      peers: [{ id: 'peer-a', nebulaIp: '127.0.0.1', port: 17946 }],
    },
  })

  // Set up event listeners
  serviceA.on('entity:changed', (event) => {
    console.log(`[A] Entity changed: ${event.entityType} (${event.action}) from ${event.source}`)
  })

  serviceB.on('entity:changed', (event) => {
    console.log(`[B] Entity changed: ${event.entityType} (${event.action}) from ${event.source}`)
  })

  try {
    // Connect both services
    console.log('\nConnecting services...')
    await Promise.all([serviceA.connect(), serviceB.connect()])
    console.log('Both services connected!')

    // Wait for sync
    await sleep(1000)

    // Test 1: Create spec on A, verify on B
    console.log('\n--- Test 1: Create spec on A ---')
    const spec1: SpecCRDT = {
      id: 's-test1',
      uuid: 'uuid-spec-1',
      title: 'Test Spec from A',
      content: '# Test Spec\n\nCreated on peer A',
      priority: 1,
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    serviceA.syncSpec(spec1)
    console.log('[A] Created spec:', spec1.id)

    // Wait for sync
    await sleep(500)

    // Verify on B
    const specOnB = serviceB.getSpec('s-test1')
    if (specOnB) {
      console.log('[B] Received spec:', specOnB.id, '-', specOnB.title)
      console.log('✓ Test 1 PASSED')
    } else {
      console.log('✗ Test 1 FAILED - spec not found on B')
    }

    // Test 2: Create issue on B, verify on A
    console.log('\n--- Test 2: Create issue on B ---')
    const issue1: IssueCRDT = {
      id: 'i-test1',
      uuid: 'uuid-issue-1',
      title: 'Test Issue from B',
      status: 'open',
      content: 'This issue was created on peer B',
      priority: 2,
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    serviceB.syncIssue(issue1)
    console.log('[B] Created issue:', issue1.id)

    // Wait for sync
    await sleep(500)

    // Verify on A
    const issueOnA = serviceA.getIssue('i-test1')
    if (issueOnA) {
      console.log('[A] Received issue:', issueOnA.id, '-', issueOnA.title)
      console.log('✓ Test 2 PASSED')
    } else {
      console.log('✗ Test 2 FAILED - issue not found on A')
    }

    // Test 3: Update issue on A, verify on B
    console.log('\n--- Test 3: Update issue on A ---')
    const updatedIssue: IssueCRDT = {
      ...issue1,
      status: 'in_progress',
      updated_at: new Date().toISOString(),
    }
    serviceA.syncIssue(updatedIssue)
    console.log('[A] Updated issue status to:', updatedIssue.status)

    // Wait for sync
    await sleep(500)

    // Verify on B
    const issueOnB = serviceB.getIssue('i-test1')
    if (issueOnB?.status === 'in_progress') {
      console.log('[B] Issue status updated:', issueOnB.status)
      console.log('✓ Test 3 PASSED')
    } else {
      console.log('✗ Test 3 FAILED - status not updated on B')
    }

    // Test 4: Verify JSONL persistence
    console.log('\n--- Test 4: Verify JSONL persistence ---')
    await sleep(1000) // Wait for debounced save

    const specsA = await fs.readFile(path.join(projectA, 'specs.jsonl'), 'utf-8')
    const issuesA = await fs.readFile(path.join(projectA, 'issues.jsonl'), 'utf-8')

    if (specsA.includes('s-test1') && issuesA.includes('i-test1')) {
      console.log('[A] JSONL files contain synced entities')
      console.log('✓ Test 4 PASSED')
    } else {
      console.log('✗ Test 4 FAILED - JSONL not updated')
    }

    // Summary
    console.log('\n=== Summary ===')
    console.log(`Specs on A: ${serviceA.getAllSpecs().length}`)
    console.log(`Issues on A: ${serviceA.getAllIssues().length}`)
    console.log(`Specs on B: ${serviceB.getAllSpecs().length}`)
    console.log(`Issues on B: ${serviceB.getAllIssues().length}`)

    // Disconnect sequentially to avoid race conditions during shutdown
    console.log('\nDisconnecting...')
    await serviceA.disconnect()
    await serviceB.disconnect()
    console.log('Done!')
  } catch (error) {
    console.error('Test error:', error)
  } finally {
    await cleanup()
  }
}

main().catch(console.error)
