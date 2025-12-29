import type { VercelRequest, VercelResponse } from '@vercel/node'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { OpenAPIV3 } from 'openapi-types'

import { MCPProxy } from '../src/openapi-mcp-server/mcp/proxy'
import notionOpenApiSpec from '../scripts/notion-openapi.json'

const baseUrl = process.env.BASE_URL ?? undefined
// Prefer NOTION_AUTH_TOKEN, but keep AUTH_TOKEN for backwards compatibility.
const authToken = process.env.NOTION_AUTH_TOKEN ?? process.env.AUTH_TOKEN

// Prepare the OpenAPI spec
function getOpenApiSpec(): OpenAPIV3.Document {
  const spec = structuredClone(notionOpenApiSpec) as unknown as OpenAPIV3.Document
  if (baseUrl && spec.servers && spec.servers[0]) {
    spec.servers[0].url = baseUrl
  }
  return spec
}

// Store active transports
const transports: Map<string, SSEServerTransport> = new Map()

// Authentication helper
function authenticate(req: VercelRequest, res: VercelResponse): boolean {
  if (!authToken) {
    return true
  }

  const authHeader = req.headers['authorization']
  const token = authHeader && typeof authHeader === 'string' ? authHeader.split(' ')[1] : null

  if (!token || token !== authToken) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }

  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (!authenticate(req, res)) {
    return
  }

  try {
    if (req.method === 'GET') {
      // SSE connection endpoint
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')

      const transport = new SSEServerTransport('/sse', res as any)
      const sessionId = Math.random().toString(36).substring(7)
      transports.set(sessionId, transport)

      const openApiSpec = getOpenApiSpec()
      const proxy = new MCPProxy('Notion API', openApiSpec)
      
      await proxy.connect(transport)

      // Clean up on close
      req.on('close', () => {
        transports.delete(sessionId)
      })

      // Start the SSE transport
      await transport.start()
    } else if (req.method === 'POST') {
      // Handle incoming messages
      const sessionId = req.query.sessionId as string
      
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Invalid session' })
        return
      }

      const transport = transports.get(sessionId)!
      await transport.handlePostMessage(req as any, res as any)
    } else {
      res.status(405).json({ error: 'Method not allowed' })
    }
  } catch (error) {
    console.error('SSE Error:', error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}


