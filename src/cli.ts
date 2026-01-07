#!/usr/bin/env node
// agentic-mesh CLI
// Implements: i-8ns6

import { Command } from 'commander'
import * as path from 'path'
import { CertManager, ConfigGenerator, LighthouseManager } from './certs'

const program = new Command()

program
  .name('agentic-mesh')
  .description('Agentic Mesh - P2P CRDT sync over Nebula networks')
  .version('0.0.1')

// =============================================================================
// Certificate Commands
// =============================================================================

const cert = program.command('cert').description('Certificate management commands')

cert
  .command('create-ca')
  .description('Create a root Certificate Authority')
  .requiredOption('-n, --name <name>', 'CA name')
  .option('-d, --duration <duration>', 'Validity duration', '8760h')
  .option('-g, --groups <groups>', 'Comma-separated list of groups')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      const cert = await certManager.createRootCA({
        name: options.name,
        duration: options.duration,
        groups: options.groups?.split(',').map((g: string) => g.trim()) ?? [],
      })

      console.log('Root CA created successfully:')
      console.log(`  Name: ${cert.name}`)
      console.log(`  Cert: ${cert.certPath}`)
      console.log(`  Key:  ${cert.keyPath}`)
      console.log(`  Expires: ${cert.expiresAt.toISOString()}`)

      await certManager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

cert
  .command('create-user-ca')
  .description('Create a user CA signed by a root CA')
  .requiredOption('-n, --name <name>', 'User CA name')
  .requiredOption('-r, --root-ca <name>', 'Root CA name to sign with')
  .option('-d, --duration <duration>', 'Validity duration', '8760h')
  .option('-g, --groups <groups>', 'Comma-separated list of groups')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      const cert = await certManager.createUserCA({
        name: options.name,
        rootCAName: options.rootCa,
        duration: options.duration,
        groups: options.groups?.split(',').map((g: string) => g.trim()) ?? [],
      })

      console.log('User CA created successfully:')
      console.log(`  Name: ${cert.name}`)
      console.log(`  Signed by: ${cert.signedBy}`)
      console.log(`  Cert: ${cert.certPath}`)
      console.log(`  Key:  ${cert.keyPath}`)
      console.log(`  Expires: ${cert.expiresAt.toISOString()}`)

      await certManager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

cert
  .command('sign')
  .description('Sign a server certificate')
  .requiredOption('-n, --name <name>', 'Certificate name')
  .requiredOption('-a, --ca <name>', 'CA name to sign with')
  .requiredOption('-i, --ip <ip>', 'Nebula IP address (e.g., 10.42.0.10/24)')
  .option('-d, --duration <duration>', 'Validity duration', '8760h')
  .option('-g, --groups <groups>', 'Comma-separated list of groups')
  .option('-s, --subnets <subnets>', 'Comma-separated list of subnets')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      const cert = await certManager.signServerCert({
        name: options.name,
        caName: options.ca,
        nebulaIp: options.ip,
        duration: options.duration,
        groups: options.groups?.split(',').map((g: string) => g.trim()) ?? [],
        subnets: options.subnets?.split(',').map((s: string) => s.trim()) ?? [],
      })

      console.log('Server certificate signed successfully:')
      console.log(`  Name: ${cert.name}`)
      console.log(`  IP: ${cert.nebulaIp}`)
      console.log(`  Signed by: ${cert.signedBy}`)
      console.log(`  Groups: ${cert.groups.join(', ') || '(none)'}`)
      console.log(`  Cert: ${cert.certPath}`)
      console.log(`  Key:  ${cert.keyPath}`)
      console.log(`  Expires: ${cert.expiresAt.toISOString()}`)

      await certManager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

cert
  .command('renew')
  .description('Renew a server certificate')
  .requiredOption('-n, --name <name>', 'Certificate name to renew')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      const cert = await certManager.renewServerCert(options.name)

      console.log('Certificate renewed successfully:')
      console.log(`  Name: ${cert.name}`)
      console.log(`  New expiry: ${cert.expiresAt.toISOString()}`)

      await certManager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

cert
  .command('revoke')
  .description('Revoke a certificate')
  .requiredOption('-n, --name <name>', 'Certificate name to revoke')
  .option('-r, --reason <reason>', 'Reason for revocation', 'unspecified')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      await certManager.revokeCert(options.name, options.reason)

      console.log(`Certificate '${options.name}' has been revoked.`)
      console.log(`  Reason: ${options.reason}`)

      await certManager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

cert
  .command('list')
  .description('List all certificates')
  .option('-t, --type <type>', 'Filter by type (root-ca, user-ca, server)')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      let certs = certManager.listCertificates()
      if (options.type) {
        certs = certs.filter((c) => c.type === options.type)
      }

      if (certs.length === 0) {
        console.log('No certificates found.')
      } else {
        console.log(`Found ${certs.length} certificate(s):\n`)
        for (const cert of certs) {
          const status = cert.revoked ? '[REVOKED]' : ''
          const expired = new Date(cert.expiresAt) < new Date() ? '[EXPIRED]' : ''
          console.log(`${cert.name} (${cert.type}) ${status}${expired}`)
          if (cert.nebulaIp) console.log(`  IP: ${cert.nebulaIp}`)
          console.log(`  Expires: ${new Date(cert.expiresAt).toISOString()}`)
          console.log()
        }
      }

      await certManager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

cert
  .command('verify')
  .description('Verify a certificate')
  .requiredOption('-n, --name <name>', 'Certificate name to verify')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      const result = await certManager.verifyCert(options.name)

      console.log(`Certificate '${options.name}':`)
      console.log(`  Valid: ${result.valid ? 'Yes' : 'No'}`)
      console.log(`  Chain valid: ${result.chainValid ? 'Yes' : 'No'}`)
      console.log(`  Not expired: ${result.notExpired ? 'Yes' : 'No'}`)
      console.log(`  Not revoked: ${result.notRevoked ? 'Yes' : 'No'}`)

      if (result.errors.length > 0) {
        console.log('\nErrors:')
        for (const error of result.errors) {
          console.log(`  - ${error}`)
        }
      }

      await certManager.shutdown()

      if (!result.valid) {
        process.exit(1)
      }
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

cert
  .command('info')
  .description('Show certificate details')
  .requiredOption('-n, --name <name>', 'Certificate name')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      const cert = certManager.getCertificate(options.name)
      if (!cert) {
        console.error(`Certificate '${options.name}' not found.`)
        process.exit(1)
      }

      console.log(`Certificate: ${cert.name}`)
      console.log(`  Type: ${cert.type}`)
      if (cert.nebulaIp) console.log(`  Nebula IP: ${cert.nebulaIp}`)
      if (cert.signedBy) console.log(`  Signed by: ${cert.signedBy}`)
      console.log(`  Groups: ${cert.groups.join(', ') || '(none)'}`)
      console.log(`  Created: ${new Date(cert.createdAt).toISOString()}`)
      console.log(`  Expires: ${new Date(cert.expiresAt).toISOString()}`)
      console.log(`  Revoked: ${cert.revoked ? 'Yes' : 'No'}`)
      console.log(`  Cert file: ${cert.certPath}`)
      console.log(`  Key file: ${cert.keyPath}`)

      await certManager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

// =============================================================================
// Config Commands
// =============================================================================

const config = program.command('config').description('Configuration generation commands')

config
  .command('generate')
  .description('Generate Nebula peer configuration')
  .requiredOption('-a, --ca-cert <path>', 'Path to CA certificate')
  .requiredOption('-e, --cert <path>', 'Path to host certificate')
  .requiredOption('-k, --key <path>', 'Path to host key')
  .requiredOption('-l, --lighthouses <list>', 'Lighthouse list: ip=endpoint,ip=endpoint')
  .option('-o, --output <path>', 'Output file path')
  .option('-p, --port <port>', 'Listen port', '4242')
  .option('--mesh', 'Include mesh-specific firewall rules')
  .action(async (options) => {
    try {
      const generator = new ConfigGenerator()

      // Parse lighthouse list
      const lighthouses: Record<string, string> = {}
      for (const entry of options.lighthouses.split(',')) {
        const [ip, endpoint] = entry.split('=')
        if (ip && endpoint) {
          lighthouses[ip.trim()] = endpoint.trim()
        }
      }

      const configOptions = {
        caCertPath: options.caCert,
        certPath: options.cert,
        keyPath: options.key,
        lighthouses,
        listenPort: parseInt(options.port, 10),
      }

      const configYaml = options.mesh
        ? generator.generateMeshPeerConfig(configOptions)
        : generator.generateNebulaConfig(configOptions)

      if (options.output) {
        await generator.writeConfig(options.output, configYaml)
        console.log(`Configuration written to: ${options.output}`)
      } else {
        console.log(configYaml)
      }
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

config
  .command('generate-lighthouse')
  .description('Generate Nebula lighthouse configuration')
  .requiredOption('-a, --ca-cert <path>', 'Path to CA certificate')
  .requiredOption('-e, --cert <path>', 'Path to host certificate')
  .requiredOption('-k, --key <path>', 'Path to host key')
  .requiredOption('-i, --ip <ip>', 'This lighthouse Nebula IP')
  .option('-l, --lighthouses <list>', 'Other lighthouses: ip=endpoint,ip=endpoint')
  .option('-o, --output <path>', 'Output file path')
  .option('-p, --port <port>', 'Listen port', '4242')
  .option('--dns', 'Enable DNS server')
  .option('--dns-port <port>', 'DNS listen port', '53')
  .action(async (options) => {
    try {
      const generator = new ConfigGenerator()

      // Parse lighthouse list
      const lighthouses: Record<string, string> = {}
      if (options.lighthouses) {
        for (const entry of options.lighthouses.split(',')) {
          const [ip, endpoint] = entry.split('=')
          if (ip && endpoint) {
            lighthouses[ip.trim()] = endpoint.trim()
          }
        }
      }

      const configYaml = generator.generateLighthouseConfig({
        caCertPath: options.caCert,
        certPath: options.cert,
        keyPath: options.key,
        lighthouses,
        nebulaIp: options.ip,
        listenPort: parseInt(options.port, 10),
        dns: options.dns
          ? { enabled: true, port: parseInt(options.dnsPort, 10) }
          : undefined,
      })

      if (options.output) {
        await generator.writeConfig(options.output, configYaml)
        console.log(`Lighthouse configuration written to: ${options.output}`)
      } else {
        console.log(configYaml)
      }
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

// =============================================================================
// Utility Commands
// =============================================================================

program
  .command('doctor')
  .description('Validate agentic-mesh setup')
  .option('-c, --certs-dir <dir>', 'Certificates directory', './certs')
  .action(async (options) => {
    try {
      console.log('Checking agentic-mesh setup...\n')

      const certManager = new CertManager({ certsDir: options.certsDir })
      await certManager.initialize()

      const validation = await certManager.validateSetup()

      console.log('Results:')
      console.log(`  nebula-cert: ${validation.nebulaCertFound ? `Found (${validation.nebulaCertVersion})` : 'Not found'}`)
      console.log(`  nebula: ${validation.nebulaFound ? `Found (${validation.nebulaVersion})` : 'Not found (optional)'}`)
      console.log(`  Certs directory: ${validation.certsDirWritable ? 'Writable' : 'Not writable'}`)

      if (validation.errors.length > 0) {
        console.log('\nErrors:')
        for (const error of validation.errors) {
          console.log(`  - ${error}`)
        }
      }

      if (validation.warnings.length > 0) {
        console.log('\nWarnings:')
        for (const warning of validation.warnings) {
          console.log(`  - ${warning}`)
        }
      }

      console.log(`\nOverall: ${validation.valid ? 'Setup is valid' : 'Setup has issues'}`)

      await certManager.shutdown()

      if (!validation.valid) {
        process.exit(1)
      }
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

// =============================================================================
// Lighthouse Commands
// =============================================================================

const lighthouse = program.command('lighthouse').description('Lighthouse management commands')

lighthouse
  .command('create')
  .description('Create a new lighthouse configuration')
  .requiredOption('-n, --name <name>', 'Lighthouse name')
  .requiredOption('-i, --ip <ip>', 'Nebula IP address (e.g., 10.42.0.1/24)')
  .requiredOption('-e, --endpoint <endpoint>', 'Public endpoint (e.g., lighthouse.example.com:4242)')
  .requiredOption('-a, --ca-cert <path>', 'Path to CA certificate')
  .requiredOption('-c, --cert <path>', 'Path to lighthouse certificate')
  .requiredOption('-k, --key <path>', 'Path to lighthouse key')
  .option('-p, --port <port>', 'Listen port', '4242')
  .option('-l, --lighthouses <list>', 'Other lighthouses: ip=endpoint,ip=endpoint')
  .option('--dns', 'Enable DNS server')
  .option('--dns-port <port>', 'DNS listen port', '53')
  .option('-d, --dir <dir>', 'Lighthouses directory', './lighthouses')
  .action(async (options) => {
    try {
      const manager = new LighthouseManager({ lighthousesDir: options.dir })
      await manager.initialize()

      // Parse other lighthouses
      const otherLighthouses: Record<string, string> = {}
      if (options.lighthouses) {
        for (const entry of options.lighthouses.split(',')) {
          const [ip, endpoint] = entry.split('=')
          if (ip && endpoint) {
            otherLighthouses[ip.trim()] = endpoint.trim()
          }
        }
      }

      const info = await manager.create({
        name: options.name,
        nebulaIp: options.ip,
        publicEndpoint: options.endpoint,
        caCertPath: options.caCert,
        certPath: options.cert,
        keyPath: options.key,
        listenPort: parseInt(options.port, 10),
        otherLighthouses,
        dns: options.dns ? { enabled: true, port: parseInt(options.dnsPort, 10) } : undefined,
      })

      console.log('Lighthouse created successfully:')
      console.log(`  Name: ${info.name}`)
      console.log(`  Nebula IP: ${info.nebulaIp}`)
      console.log(`  Endpoint: ${info.publicEndpoint}`)
      console.log(`  Config: ${info.configPath}`)

      await manager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

lighthouse
  .command('start')
  .description('Start a lighthouse process')
  .requiredOption('-n, --name <name>', 'Lighthouse name')
  .option('-d, --dir <dir>', 'Lighthouses directory', './lighthouses')
  .action(async (options) => {
    try {
      const manager = new LighthouseManager({ lighthousesDir: options.dir })
      await manager.initialize()

      await manager.start(options.name)

      const info = manager.get(options.name)
      console.log(`Lighthouse '${options.name}' started.`)
      console.log(`  PID: ${info?.pid}`)

      // Don't call shutdown to keep the process running
      // User should manage this with systemd or similar
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

lighthouse
  .command('stop')
  .description('Stop a lighthouse process')
  .requiredOption('-n, --name <name>', 'Lighthouse name')
  .option('-d, --dir <dir>', 'Lighthouses directory', './lighthouses')
  .action(async (options) => {
    try {
      const manager = new LighthouseManager({ lighthousesDir: options.dir })
      await manager.initialize()

      await manager.stop(options.name)

      console.log(`Lighthouse '${options.name}' stopped.`)

      await manager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

lighthouse
  .command('restart')
  .description('Restart a lighthouse process')
  .requiredOption('-n, --name <name>', 'Lighthouse name')
  .option('-d, --dir <dir>', 'Lighthouses directory', './lighthouses')
  .action(async (options) => {
    try {
      const manager = new LighthouseManager({ lighthousesDir: options.dir })
      await manager.initialize()

      await manager.restart(options.name)

      const info = manager.get(options.name)
      console.log(`Lighthouse '${options.name}' restarted.`)
      console.log(`  PID: ${info?.pid}`)
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

lighthouse
  .command('status')
  .description('Show lighthouse status')
  .requiredOption('-n, --name <name>', 'Lighthouse name')
  .option('-d, --dir <dir>', 'Lighthouses directory', './lighthouses')
  .action(async (options) => {
    try {
      const manager = new LighthouseManager({ lighthousesDir: options.dir })
      await manager.initialize()

      const health = await manager.health(options.name)

      console.log(`Lighthouse '${options.name}':`)
      console.log(`  Status: ${health.status}`)
      console.log(`  Healthy: ${health.healthy ? 'Yes' : 'No'}`)
      if (health.pid) console.log(`  PID: ${health.pid}`)
      if (health.uptime) console.log(`  Uptime: ${Math.floor(health.uptime / 1000)}s`)
      if (health.error) console.log(`  Error: ${health.error}`)

      await manager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

lighthouse
  .command('list')
  .description('List all lighthouses')
  .option('-d, --dir <dir>', 'Lighthouses directory', './lighthouses')
  .action(async (options) => {
    try {
      const manager = new LighthouseManager({ lighthousesDir: options.dir })
      await manager.initialize()

      const lighthouses = manager.list()

      if (lighthouses.length === 0) {
        console.log('No lighthouses configured.')
      } else {
        console.log(`Found ${lighthouses.length} lighthouse(s):\n`)
        for (const lh of lighthouses) {
          const statusIcon = lh.status === 'running' ? '[RUNNING]' : lh.status === 'error' ? '[ERROR]' : '[STOPPED]'
          console.log(`${lh.name} ${statusIcon}`)
          console.log(`  IP: ${lh.nebulaIp}`)
          console.log(`  Endpoint: ${lh.publicEndpoint}`)
          if (lh.pid) console.log(`  PID: ${lh.pid}`)
          console.log()
        }
      }

      await manager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

lighthouse
  .command('remove')
  .description('Remove a lighthouse configuration')
  .requiredOption('-n, --name <name>', 'Lighthouse name')
  .option('-d, --dir <dir>', 'Lighthouses directory', './lighthouses')
  .action(async (options) => {
    try {
      const manager = new LighthouseManager({ lighthousesDir: options.dir })
      await manager.initialize()

      await manager.remove(options.name)

      console.log(`Lighthouse '${options.name}' removed.`)

      await manager.shutdown()
    } catch (error) {
      console.error('Error:', (error as Error).message)
      process.exit(1)
    }
  })

program.parse()
