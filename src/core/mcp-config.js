// These are client configuration documents, not commands executed by the application.
export function buildMcpConfigs({ port, token, bridgePath }) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = { Authorization: `Bearer ${token}` };
  const stdio = { command: 'node', args: [bridgePath] };
  return [
    { id: 'cursor', label: 'Cursor', description: '添加到 Cursor 的 MCP 设置或 .cursor/mcp.json。', config: { mcpServers: { zhidian: { url, headers } } } },
    { id: 'vscode', label: 'VS Code / Copilot', description: '保存到工作区 .vscode/mcp.json，然后在 MCP 服务器列表中启动。', config: { servers: { zhidian: { type: 'http', url, headers } } } },
    { id: 'claude-desktop', label: 'Claude Desktop', description: '合并到 Claude Desktop 的 MCP 配置。需要本机安装 Node.js，并先启动指点。', config: { mcpServers: { zhidian: stdio } } },
    { id: 'stdio', label: '通用 stdio 客户端', description: '适用于支持启动本地 MCP 命令的客户端。需要 Node.js；请按客户端要求填入 command 和 args。', config: stdio },
    { id: 'http', label: '通用 HTTP 客户端', description: '使用 Streamable HTTP 连接，填入以下地址及认证头。指点必须保持运行。', config: { transport: 'streamable-http', url, headers } },
  ];
}
