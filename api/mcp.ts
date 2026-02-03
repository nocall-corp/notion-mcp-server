import type { VercelRequest, VercelResponse } from '@vercel/node'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAPIV3 } from 'openapi-types'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import axios from 'axios'

const baseUrl = process.env.BASE_URL ?? undefined
// Prefer NOTION_AUTH_TOKEN, but keep AUTH_TOKEN for backwards compatibility.
const authToken = process.env.NOTION_AUTH_TOKEN ?? process.env.AUTH_TOKEN
const requireAuth =
  process.env.REQUIRE_AUTH === 'true' ||
  (process.env.REQUIRE_AUTH !== 'false' && process.env.VERCEL_ENV === 'production')

// Read OpenAPI spec from file system
function loadOpenApiSpec(): OpenAPIV3.Document {
  try {
    const specPath = join(process.cwd(), 'scripts/notion-openapi.json')
    const rawSpec = readFileSync(specPath, 'utf-8')
    const spec = JSON.parse(rawSpec) as OpenAPIV3.Document
    if (baseUrl && spec.servers && spec.servers[0]) {
      spec.servers[0].url = baseUrl
    }
    return spec
  } catch (error) {
    console.error('Failed to load OpenAPI spec:', error)
    throw error
  }
}

// Simplified MCP Proxy for Vercel
class SimpleMCPProxy {
  private server: Server
  private openApiSpec: OpenAPIV3.Document
  private headers: Record<string, string>

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
    this.openApiSpec = openApiSpec
    this.headers = this.parseHeadersFromEnv()
    this.setupHandlers()
  }

  private parseHeadersFromEnv(): Record<string, string> {
    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      return {
        'Authorization': `Bearer ${notionToken}`,
        'Notion-Version': '2025-09-03',
        'Content-Type': 'application/json'
      }
    }
    return {}
  }

  private setupHandlers() {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = []
      
      if (this.openApiSpec.paths) {
        for (const [path, pathItem] of Object.entries(this.openApiSpec.paths)) {
          if (!pathItem) continue
          
          for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
            const operation = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined
            if (!operation?.operationId) continue
            
            const tool: Tool = {
              name: operation.operationId.slice(0, 64),
              description: operation.summary || operation.description || `${method.toUpperCase()} ${path}`,
              inputSchema: {
                type: 'object',
                properties: {},
                required: []
              }
            }
            
            // Add parameters to input schema
            if (operation.parameters) {
              for (const param of operation.parameters) {
                if ('name' in param && 'schema' in param) {
                  (tool.inputSchema.properties as any)[param.name] = param.schema || { type: 'string' }
                  if (param.required) {
                    (tool.inputSchema.required as string[]).push(param.name)
                  }
                }
              }
            }
            
            // Add request body to input schema
            if (operation.requestBody && 'content' in operation.requestBody) {
              const content = operation.requestBody.content
              const jsonContent = content['application/json']
              if (jsonContent?.schema) {
                (tool.inputSchema.properties as any)['body'] = jsonContent.schema
              }
            }
            
            tools.push(tool)
          }
        }
      }
      
      return { tools }
    })

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params
      
      // Find the operation
      let foundPath: string | null = null
      let foundMethod: string | null = null
      let foundOperation: OpenAPIV3.OperationObject | null = null
      
      if (this.openApiSpec.paths) {
        for (const [path, pathItem] of Object.entries(this.openApiSpec.paths)) {
          if (!pathItem) continue
          for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
            const operation = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined
            if (operation?.operationId?.slice(0, 64) === name) {
              foundPath = path
              foundMethod = method
              foundOperation = operation
              break
            }
          }
          if (foundPath) break
        }
      }
      
      if (!foundPath || !foundMethod || !foundOperation) {
        throw new Error(`Operation ${name} not found`)
      }
      
      // Build URL with path parameters
      const serverUrl = this.openApiSpec.servers?.[0]?.url || 'https://api.notion.com'
      let url = `${serverUrl}${foundPath}`
      const queryParams: Record<string, string> = {}
      let body: any = undefined
      
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (key === 'body') {
            body = value
          } else if (url.includes(`{${key}}`)) {
            url = url.replace(`{${key}}`, encodeURIComponent(String(value)))
          } else {
            queryParams[key] = String(value)
          }
        }
      }
      
      try {
        const response = await axios({
          method: foundMethod,
          url,
          headers: this.headers,
          params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
          data: body
        })
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(response.data)
          }]
        }
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: error.message,
              data: error.response?.data
            })
          }]
        }
      }
    })
  }

  async connect(transport: Transport) {
    await this.server.connect(transport)
  }
}

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}

// Authentication helper
function authenticate(req: VercelRequest, res: VercelResponse): boolean {
  // Fail closed in production if auth is required but not configured.
  if (requireAuth && !authToken) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Server misconfigured: NOTION_AUTH_TOKEN (or legacy AUTH_TOKEN) is required' },
      id: null
    })
    return false
  }

  if (!authToken) return true

  const authHeader = req.headers['authorization']
  const authHeaderStr = Array.isArray(authHeader) ? authHeader[0] : authHeader
  const bearerToken =
    authHeaderStr && typeof authHeaderStr === 'string' && authHeaderStr.toLowerCase().startsWith('bearer ')
      ? authHeaderStr.slice('bearer '.length).trim()
      : null

  const directTokenHeader = req.headers['x-auth-token']
  const directToken = Array.isArray(directTokenHeader) ? directTokenHeader[0] : directTokenHeader
  const token = bearerToken || (typeof directToken === 'string' ? directToken : null)
  
  if (!token || token !== authToken) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null
    })
    return false
  }
  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (!authenticate(req, res)) return

  try {
    if (req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport: StreamableHTTPServerTransport

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId]
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport
          }
        })

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId]
          }
        }

        const openApiSpec = loadOpenApiSpec()
        const proxy = new SimpleMCPProxy('Notion API', openApiSpec)
        await proxy.connect(transport)
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null
        })
        return
      }

      await transport.handleRequest(req as any, res as any, req.body)
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      await transports[sessionId].handleRequest(req as any, res as any)
    } else {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method not allowed' },
        id: null
      })
    }
  } catch (error) {
    console.error('MCP Error:', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : 'Unknown'}` },
        id: null
      })
    }
  }
}
