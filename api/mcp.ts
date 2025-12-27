import type { VercelRequest, VercelResponse } from '@vercel/node'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { OpenAPIV3 } from 'openapi-types'

import { MCPProxy } from '../src/openapi-mcp-server/mcp/proxy'
// Import the OpenAPI spec directly as a module
import notionOpenApiSpec from '../scripts/notion-openapi.json'

const baseUrl = process.env.BASE_URL ?? undefined

// Get auth token from environment variable
const authToken = process.env.AUTH_TOKEN

// Prepare the OpenAPI spec
function getOpenApiSpec(): OpenAPIV3.Document {
  // Cast through unknown to avoid strict type checking on JSON import
  const spec = structuredClone(notionOpenApiSpec) as unknown as OpenAPIV3.Document
  if (baseUrl && spec.servers && spec.servers[0]) {
    spec.servers[0].url = baseUrl
  }
  return spec
}

// Map to store transports by session ID (Note: In serverless, this will be reset on cold starts)
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}

// Authentication helper
function authenticate(req: VercelRequest, res: VercelResponse): boolean {
  if (!authToken) {
    // If no auth token is set, skip authentication
    return true
  }

  const authHeader = req.headers['authorization']
  const token = authHeader && typeof authHeader === 'string' ? authHeader.split(' ')[1] : null

  if (!token) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Unauthorized: Missing bearer token',
      },
      id: null,
    })
    return false
  }

  if (token !== authToken) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: {
        code: -32002,
        message: 'Forbidden: Invalid bearer token',
      },
      id: null,
    })
    return false
  }

  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  // Authenticate
  if (!authenticate(req, res)) {
    return
  }

  try {
    console.log('MCP request received:', req.method, JSON.stringify(req.body))
    
    if (req.method === 'POST') {
      // Handle POST requests for client-to-server communication
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport: StreamableHTTPServerTransport

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId]
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        console.log('Creating new transport for initialization request')
        
        try {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
              console.log('Session initialized:', sessionId)
              // Store the transport by session ID
              transports[sessionId] = transport
            }
          })

          // Clean up transport when closed
          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId]
            }
          }

          console.log('Getting OpenAPI spec')
          const openApiSpec = getOpenApiSpec()
          
          console.log('Creating MCPProxy')
          const proxy = new MCPProxy('Notion API', openApiSpec)
          
          console.log('Connecting proxy to transport')
          await proxy.connect(transport)
          
          console.log('Proxy connected successfully')
        } catch (initError) {
          console.error('Error during initialization:', initError)
          throw initError
        }
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        })
        return
      }

      // Handle the request
      await transport.handleRequest(req as any, res as any, req.body)
    } else if (req.method === 'GET') {
      // Handle GET requests for server-to-client notifications
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }

      const transport = transports[sessionId]
      await transport.handleRequest(req as any, res as any)
    } else if (req.method === 'DELETE') {
      // Handle DELETE requests for session termination
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }

      const transport = transports[sessionId]
      await transport.handleRequest(req as any, res as any)
    } else {
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32601,
          message: 'Method not allowed',
        },
        id: null,
      })
    }
  } catch (error) {
    console.error('Error handling MCP request:', error)
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack')
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
        id: null,
      })
    }
  }
}
