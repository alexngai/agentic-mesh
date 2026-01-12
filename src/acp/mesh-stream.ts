// Mesh Stream Adapter for ACP SDK
// Creates an ACP SDK-compatible Stream that communicates over the mesh network
// Implements: s-4hjr

import type { AnyMessage } from '@agentclientprotocol/sdk'
import type { Stream } from '@agentclientprotocol/sdk'
import type { NebulaMesh } from '../mesh/nebula-mesh'
import type { PeerInfo } from '../types'
import { MessageChannel } from '../channel/message-channel'

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for mesh stream
 */
export interface MeshStreamConfig {
  /** Channel name for ACP messages (default: 'acp') */
  channel?: string
  /** Target peer ID for point-to-point communication */
  peerId: string
}

/**
 * Envelope for ACP messages sent over mesh
 */
export interface AcpMeshEnvelope {
  type: 'acp:message'
  message: AnyMessage
  /** Source peer ID */
  from?: string
}

// =============================================================================
// Mesh Stream
// =============================================================================

/**
 * Creates an ACP SDK-compatible Stream that communicates over the mesh network.
 *
 * This allows using the official ACP SDK (AgentSideConnection, ClientSideConnection)
 * with mesh-based transport instead of stdio.
 *
 * @param mesh The NebulaMesh instance
 * @param config Stream configuration including target peer ID
 * @returns An ACP SDK Stream for bidirectional communication
 *
 * @example
 * ```typescript
 * import { AgentSideConnection } from '@agentclientprotocol/sdk'
 * import { NebulaMesh, meshStream } from 'agentic-mesh'
 *
 * const mesh = new NebulaMesh(config)
 * await mesh.connect()
 *
 * // Create a stream to communicate with a specific peer
 * const stream = meshStream(mesh, { peerId: 'peer-b' })
 *
 * // Use the stream with the ACP SDK
 * const connection = new AgentSideConnection(
 *   (conn) => new MyAgent(conn),
 *   stream
 * )
 * ```
 */
export function meshStream(mesh: NebulaMesh, config: MeshStreamConfig): Stream {
  const channelName = config.channel ?? 'acp'
  const targetPeerId = config.peerId
  const localPeerId = mesh.getSelf().id

  // Create or get the channel
  const channel = mesh.createChannel<AcpMeshEnvelope>(channelName)

  // Queue for incoming messages
  const messageQueue: AnyMessage[] = []
  let resolveNext: ((message: AnyMessage) => void) | null = null

  // Handle incoming messages from the mesh
  const messageHandler = (envelope: AcpMeshEnvelope, from: PeerInfo) => {
    // Only accept messages from the target peer
    if (from.id !== targetPeerId) {
      return
    }

    const message = envelope.message
    if (resolveNext) {
      resolveNext(message)
      resolveNext = null
    } else {
      messageQueue.push(message)
    }
  }

  channel.on('message', messageHandler)

  // Create readable stream (incoming messages)
  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      // Get next message from queue or wait
      if (messageQueue.length > 0) {
        controller.enqueue(messageQueue.shift()!)
      } else {
        const message = await new Promise<AnyMessage>((resolve) => {
          resolveNext = resolve
        })
        controller.enqueue(message)
      }
    },
    cancel() {
      channel.off('message', messageHandler)
    },
  })

  // Create writable stream (outgoing messages)
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      const envelope: AcpMeshEnvelope = {
        type: 'acp:message',
        message,
        from: localPeerId,
      }
      channel.send(targetPeerId, envelope)
    },
  })

  return { readable, writable }
}

/**
 * Creates a pair of connected streams for testing.
 *
 * Messages written to one stream's writable appear on the other's readable.
 * Useful for unit testing without a real mesh network.
 *
 * @returns A tuple of [streamA, streamB] that are connected
 *
 * @example
 * ```typescript
 * const [agentStream, clientStream] = createConnectedStreams()
 *
 * const agent = new AgentSideConnection((conn) => new MyAgent(conn), agentStream)
 * const client = new ClientSideConnection((agent) => new MyClient(agent), clientStream)
 * ```
 */
export function createConnectedStreams(): [Stream, Stream] {
  // Queues for each direction
  const aToB: AnyMessage[] = []
  const bToA: AnyMessage[] = []
  let resolveAToB: ((msg: AnyMessage) => void) | null = null
  let resolveBToA: ((msg: AnyMessage) => void) | null = null

  // Stream A: writes to aToB, reads from bToA
  const streamA: Stream = {
    writable: new WritableStream<AnyMessage>({
      write(message) {
        if (resolveAToB) {
          resolveAToB(message)
          resolveAToB = null
        } else {
          aToB.push(message)
        }
      },
    }),
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        if (bToA.length > 0) {
          controller.enqueue(bToA.shift()!)
        } else {
          const msg = await new Promise<AnyMessage>((resolve) => {
            resolveBToA = resolve
          })
          controller.enqueue(msg)
        }
      },
    }),
  }

  // Stream B: writes to bToA, reads from aToB
  const streamB: Stream = {
    writable: new WritableStream<AnyMessage>({
      write(message) {
        if (resolveBToA) {
          resolveBToA(message)
          resolveBToA = null
        } else {
          bToA.push(message)
        }
      },
    }),
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        if (aToB.length > 0) {
          controller.enqueue(aToB.shift()!)
        } else {
          const msg = await new Promise<AnyMessage>((resolve) => {
            resolveAToB = resolve
          })
          controller.enqueue(msg)
        }
      },
    }),
  }

  return [streamA, streamB]
}
