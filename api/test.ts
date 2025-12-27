import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Test 1: Basic response
    const tests: { name: string; status: string; error?: string }[] = []
    
    tests.push({ name: 'basic', status: 'ok' })
    
    // Test 2: Environment variables
    tests.push({ 
      name: 'env_notion_token', 
      status: process.env.NOTION_TOKEN ? 'set' : 'not_set' 
    })
    
    // Test 3: Import OpenAPI spec
    try {
      const spec = await import('../scripts/notion-openapi.json')
      tests.push({ name: 'openapi_spec', status: 'ok', error: `keys: ${Object.keys(spec.default || spec).length}` })
    } catch (e) {
      tests.push({ name: 'openapi_spec', status: 'error', error: String(e) })
    }
    
    // Test 4: Import MCP SDK
    try {
      const sdk = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
      tests.push({ name: 'mcp_sdk', status: 'ok' })
    } catch (e) {
      tests.push({ name: 'mcp_sdk', status: 'error', error: String(e) })
    }
    
    // Test 5: Import MCPProxy
    try {
      const proxy = await import('../src/openapi-mcp-server/mcp/proxy')
      tests.push({ name: 'mcp_proxy', status: 'ok' })
    } catch (e) {
      tests.push({ name: 'mcp_proxy', status: 'error', error: String(e) })
    }
    
    res.status(200).json({ tests })
  } catch (error) {
    res.status(500).json({ 
      error: 'Test failed', 
      message: error instanceof Error ? error.message : String(error) 
    })
  }
}

