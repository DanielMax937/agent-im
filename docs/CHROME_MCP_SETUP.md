# Chrome DevTools MCP Setup Documentation

## Overview

The chrome-devtool-mcp integration uses the **@modelcontextprotocol/server-puppeteer** MCP server for browser automation and web scraping capabilities.

## MCP Server Details

- **Package**: `@modelcontextprotocol/server-puppeteer`
- **Version**: 2025.5.12 (latest)
- **Source**: https://npm.im/@modelcontextprotocol/server-puppeteer
- **Maintainers**: jspahrsummers, thedsp, ashwin-ant
- **Published**: 2025-05-12

## Connection Methods

The MCP server supports three transport mechanisms:

### 1. **stdio** (Recommended for Local Development)
- Direct process communication via stdin/stdout
- No network setup required
- Best performance for local use
- Command: `npx -y @modelcontextprotocol/server-puppeteer`

**Pros:**
- Simple setup
- No authentication needed
- Low latency
- No network configuration

**Cons:**
- Local only
- Cannot be shared across network

### 2. **HTTP** (For Remote/Networked Access)
- RESTful API communication
- Supports custom headers for authentication
- Can be accessed remotely
- Requires server URL

**Pros:**
- Remote access support
- Standard HTTP tooling
- Easy to debug with curl/Postman
- Supports authentication headers

**Cons:**
- Requires server setup
- Network latency
- More complex error handling

### 3. **SSE** (Server-Sent Events)
- Real-time streaming updates
- Ideal for browser event monitoring
- Requires server URL

**Pros:**
- Real-time updates
- Efficient for streaming data
- Standard browser support

**Cons:**
- Requires server setup
- More complex client implementation
- Unidirectional (server to client)

## Python Dependencies

The following packages are required for the Python MCP client:

### Core Dependencies

```toml
[project.dependencies]
beautifulsoup4 = ">=4.12.0"    # HTML parsing and manipulation
markdownify = ">=0.11.0"        # HTML to Markdown conversion
httpx = ">=0.27.0"              # Async HTTP client for HTTP/SSE transport
html2text = ">=2020.1.16"       # HTML to plain text conversion
```

### Dependency Details

1. **beautifulsoup4** (>=4.12.0)
   - Purpose: Parse and navigate HTML documents
   - Use case: Extract text content from scraped pages
   - Features: CSS selectors, tree navigation, tag manipulation

2. **markdownify** (>=0.11.0)
   - Purpose: Convert HTML to Markdown format
   - Use case: Generate markdown content from web pages
   - Features: Preserves structure, handles links and images

3. **httpx** (>=0.27.0)
   - Purpose: Async HTTP client
   - Use case: Communicate with MCP server via HTTP/SSE
   - Features: HTTP/2, async/await, connection pooling

4. **html2text** (>=2020.1.16)
   - Purpose: Convert HTML to formatted plain text
   - Use case: Generate readable text with links preserved
   - Features: Markdown-style output, configurable formatting

## Installation

### Install Python Dependencies

```bash
pip install -e .
```

Or manually:

```bash
pip install beautifulsoup4>=4.12.0 markdownify>=0.11.0 httpx>=0.27.0 html2text>=2020.1.16
```

### Install MCP Server (No Installation Required)

The MCP server is run via npx, which automatically downloads and executes it:

```bash
npx -y @modelcontextprotocol/server-puppeteer
```

## Available MCP Tools

The puppeteer MCP server provides the following tools:

1. **puppeteer_navigate**
   - Navigate browser to URL
   - Arguments: `{url: string}`

2. **puppeteer_screenshot**
   - Capture screenshot of page
   - Arguments: `{path: string, fullPage?: boolean}`

3. **puppeteer_click**
   - Click on element
   - Arguments: `{selector: string}`

4. **puppeteer_fill**
   - Fill form field
   - Arguments: `{selector: string, value: string}`

5. **puppeteer_evaluate**
   - Execute JavaScript in browser context
   - Arguments: `{script: string}`

## Client Implementation

The client is implemented in `/Users/caoxiaopeng/service/agent-im/app/core/chrome_mcp_client.py`

### Key Features

- Multi-transport support (stdio, HTTP, SSE)
- Content extraction in multiple formats (HTML, text, Markdown)
- Screenshot capabilities
- Async/await based API

### Usage Example

```python
from app.core.chrome_mcp_client import ChromeMCPClient, MCPConnection

# Create stdio connection (local)
config = MCPConnection(transport="stdio")
client = ChromeMCPClient(config)

await client.connect()

# Navigate and extract content
content = await client.navigate_and_extract("https://example.com")
print(content['markdown'])

# Take screenshot
await client.screenshot("/tmp/page.png")

await client.close()
```

## Configuration

### Environment Variables (if needed)

```bash
# For HTTP/SSE transport
export MCP_SERVER_URL="http://localhost:3000"
export MCP_AUTH_TOKEN="your-token-here"
```

### Python Config

```python
# stdio (recommended)
stdio_config = MCPConnection(transport="stdio")

# HTTP with auth
http_config = MCPConnection(
    transport="http",
    server_url="http://localhost:3000",
    headers={"Authorization": "Bearer token"}
)

# SSE
sse_config = MCPConnection(
    transport="sse",
    server_url="http://localhost:3000"
)
```

## Testing Connection

```bash
# Test MCP server availability
npx -y @modelcontextprotocol/inspector --help

# Run inspector in CLI mode
npx -y @modelcontextprotocol/inspector --cli --transport stdio
```

## Integration Points

The Chrome MCP client can be integrated into:

1. **Web Research Agent** - Automated web scraping for research tasks
2. **Content Ingestion** - Extract and convert web content to markdown
3. **Screenshot Service** - Capture visual state of web pages
4. **Form Automation** - Fill and submit web forms programmatically
5. **Browser Testing** - Automated browser interaction testing

## Next Steps

1. ✅ Dependencies documented in pyproject.toml
2. ✅ Client stub created at app/core/chrome_mcp_client.py
3. ✅ Connection methods documented
4. ⏳ Test connection with MCP server
5. ⏳ Integrate with research agent workflow
6. ⏳ Add error handling and retries
7. ⏳ Add rate limiting for web scraping
8. ⏳ Add caching for repeated requests

## References

- MCP Protocol: https://modelcontextprotocol.io/
- Puppeteer Server: https://npm.im/@modelcontextprotocol/server-puppeteer
- MCP Inspector: https://npm.im/@modelcontextprotocol/inspector
