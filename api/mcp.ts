import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpenAPIV3 } from 'openapi-types'
import axios from 'axios'

const baseUrl = process.env.BASE_URL ?? undefined
const authToken = process.env.NOTION_AUTH_TOKEN ?? process.env.AUTH_TOKEN
const requireAuth =
  process.env.REQUIRE_AUTH === 'true' ||
  (process.env.REQUIRE_AUTH !== 'false' && process.env.VERCEL_ENV === 'production')

// --- OpenAPI spec loading (cached at module level) ---

let cachedSpec: OpenAPIV3.Document | null = null

function loadOpenApiSpec(): OpenAPIV3.Document {
  if (cachedSpec) return cachedSpec
  const specPath = join(process.cwd(), 'scripts/notion-openapi.json')
  const rawSpec = readFileSync(specPath, 'utf-8')
  const spec = JSON.parse(rawSpec) as OpenAPIV3.Document
  if (baseUrl && spec.servers && spec.servers[0]) {
    spec.servers[0].url = baseUrl
  }
  cachedSpec = spec
  return spec
}

// --- Notion API headers ---

function getNotionHeaders(): Record<string, string> {
  const notionToken = process.env.NOTION_TOKEN
  if (notionToken) {
    return {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    }
  }
  return {}
}

// --- Tool generation from OpenAPI spec ---

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, any>
}

function generateTools(spec: OpenAPIV3.Document): McpTool[] {
  const tools: McpTool[] = []
  if (!spec.paths) return tools

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined
      if (!operation?.operationId) continue

      const tool: McpTool = {
        name: operation.operationId.slice(0, 64),
        description: operation.summary || operation.description || `${method.toUpperCase()} ${path}`,
        inputSchema: { type: 'object', properties: {}, required: [] },
      }

      if (operation.parameters) {
        for (const param of operation.parameters) {
          if ('name' in param && 'schema' in param) {
            ;(tool.inputSchema.properties as any)[param.name] = param.schema || { type: 'string' }
            if (param.required) {
              ;(tool.inputSchema.required as string[]).push(param.name)
            }
          }
        }
      }

      if (operation.requestBody && 'content' in operation.requestBody) {
        const jsonContent = operation.requestBody.content['application/json']
        if (jsonContent?.schema) {
          ;(tool.inputSchema.properties as any)['body'] = jsonContent.schema
        }
      }

      tools.push(tool)
    }
  }
  return tools
}

// --- Tool execution ---

async function executeTool(
  name: string,
  args: Record<string, unknown> | undefined,
  spec: OpenAPIV3.Document
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  let foundPath: string | null = null
  let foundMethod: string | null = null

  if (spec.paths) {
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem) continue
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const op = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined
        if (op?.operationId?.slice(0, 64) === name) {
          foundPath = path
          foundMethod = method
          break
        }
      }
      if (foundPath) break
    }
  }

  if (!foundPath || !foundMethod) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Operation ${name} not found` }) }], isError: true }
  }

  const serverUrl = spec.servers?.[0]?.url || 'https://api.notion.com'
  let url = `${serverUrl}${foundPath}`
  const queryParams: Record<string, string> = {}
  let body: any = undefined

  if (args) {
    for (const [key, value] of Object.entries(args)) {
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
      headers: getNotionHeaders(),
      params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
      data: body,
    })
    return { content: [{ type: 'text', text: JSON.stringify(response.data) }] }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: error.message, data: error.response?.data }) }],
      isError: true,
    }
  }
}

// --- Authentication ---

function authenticate(req: VercelRequest, res: VercelResponse): boolean {
  if (requireAuth && !authToken) {
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Server misconfigured: NOTION_AUTH_TOKEN is required' }, id: null })
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
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null })
    return false
  }
  return true
}

// --- Stateless JSON-RPC handler (no session management needed) ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  if (!authenticate(req, res)) return

  // #region agent log
  console.log(`[DEBUG] method=${req.method} body_method=${req.body?.method} body_id=${req.body?.id}`)
  // #endregion

  if (req.method === 'GET') {
    // SSE endpoint - not needed for stateless mode, return empty
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.status(200).end()
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null })
    return
  }

  const body = req.body
  if (!body || !body.method) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' }, id: null })
    return
  }

  const spec = loadOpenApiSpec()

  try {
    switch (body.method) {
      case 'initialize': {
        // #region agent log
        console.log(`[DEBUG] handling initialize`)
        // #endregion
        const sessionId = `stateless-${Date.now()}`
        res.setHeader('mcp-session-id', sessionId)
        res.status(200).json({
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'Notion API', version: '2.0.0' },
          },
          id: body.id,
        })
        return
      }

      case 'notifications/initialized': {
        res.status(200).json({ jsonrpc: '2.0', result: {}, id: body.id })
        return
      }

      case 'tools/list': {
        // #region agent log
        console.log(`[DEBUG] handling tools/list`)
        // #endregion
        const tools = generateTools(spec)
        res.status(200).json({ jsonrpc: '2.0', result: { tools }, id: body.id })
        return
      }

      case 'tools/call': {
        const toolName = body.params?.name
        const toolArgs = body.params?.arguments
        // #region agent log
        console.log(`[DEBUG] handling tools/call name=${toolName}`)
        // #endregion
        const result = await executeTool(toolName, toolArgs, spec)
        res.status(200).json({ jsonrpc: '2.0', result, id: body.id })
        return
      }

      case 'ping': {
        res.status(200).json({ jsonrpc: '2.0', result: {}, id: body.id })
        return
      }

      default: {
        // #region agent log
        console.log(`[DEBUG] unknown method: ${body.method}`)
        // #endregion
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${body.method}` },
          id: body.id,
        })
        return
      }
    }
  } catch (error) {
    // #region agent log
    console.error(`[DEBUG] handler error:`, error)
    // #endregion
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : 'Unknown'}` },
        id: body?.id ?? null,
      })
    }
  }
}
