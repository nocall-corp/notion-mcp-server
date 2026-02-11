import { initializeMcpApiHandler } from "@vercel/mcp-adapter"
import { z } from "zod"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OpenAPIV3 } from "openapi-types"
import axios from "axios"

// --- OpenAPI spec loading ---

let cachedSpec: OpenAPIV3.Document | null = null

function loadOpenApiSpec(): OpenAPIV3.Document {
  if (cachedSpec) return cachedSpec
  const baseUrl = process.env.BASE_URL ?? undefined
  const specPath = join(process.cwd(), "scripts/notion-openapi.json")
  const rawSpec = readFileSync(specPath, "utf-8")
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
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    }
  }
  return {}
}

// --- Find operation in OpenAPI spec ---

function findOperation(spec: OpenAPIV3.Document, toolName: string) {
  if (!spec.paths) return null
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined
      if (op?.operationId?.slice(0, 64) === toolName) {
        return { path, method, operation: op }
      }
    }
  }
  return null
}

// --- Execute a Notion API call ---

async function executeNotionCall(
  spec: OpenAPIV3.Document,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const found = findOperation(spec, toolName)
  if (!found) {
    return JSON.stringify({ error: `Operation ${toolName} not found` })
  }

  const serverUrl = spec.servers?.[0]?.url || "https://api.notion.com"
  let url = `${serverUrl}${found.path}`
  const queryParams: Record<string, string> = {}
  let body: any = undefined

  for (const [key, value] of Object.entries(args)) {
    if (key === "body") {
      body = value
    } else if (url.includes(`{${key}}`)) {
      url = url.replace(`{${key}}`, encodeURIComponent(String(value)))
    } else {
      queryParams[key] = String(value)
    }
  }

  try {
    const response = await axios({
      method: found.method,
      url,
      headers: getNotionHeaders(),
      params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
      data: body,
    })
    return JSON.stringify(response.data)
  } catch (error: any) {
    return JSON.stringify({
      status: "error",
      message: error.message,
      data: error.response?.data,
    })
  }
}

// --- MCP handler using @vercel/mcp-adapter ---

const handler = initializeMcpApiHandler(
  (server) => {
    const spec = loadOpenApiSpec()

    // Dynamically register all tools from OpenAPI spec
    if (spec.paths) {
      for (const [path, pathItem] of Object.entries(spec.paths)) {
        if (!pathItem) continue
        for (const method of ["get", "post", "put", "patch", "delete"] as const) {
          const operation = (pathItem as any)[method] as OpenAPIV3.OperationObject | undefined
          if (!operation?.operationId) continue

          const toolName = operation.operationId.slice(0, 64)
          const description = operation.summary || operation.description || `${method.toUpperCase()} ${path}`

          // Use a permissive schema - the actual validation happens at the Notion API level
          server.tool(
            toolName,
            description,
            { args: z.record(z.unknown()).optional().describe("Tool arguments") },
            async ({ args: toolArgs }) => {
              const result = await executeNotionCall(spec, toolName, toolArgs || {})
              return { content: [{ type: "text" as const, text: result }] }
            }
          )
        }
      }
    }
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

export { handler as GET, handler as POST }
