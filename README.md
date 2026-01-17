# Ansible Environments

A VS Code extension for managing Ansible development environments, leveraging the [Microsoft Python Environments extension](https://github.com/microsoft/vscode-python-environments) API.

## Features

### Sidebar Views

The extension adds an **Ansible Environments** panel to the VS Code Activity Bar with four collapsible views:

#### Environment Managers

- Lists all available Python environments grouped by manager type (venv, Global, Conda, etc.)
- Click an environment to set it as the active Python environment for the workspace
- Checkmark icon indicates the currently selected environment
- **+** button to create a new Python environment
- **Refresh** button to reload the environment list
- Auto-updates when the Python environment changes

#### Ansible Dev Tools

- Displays installed `ansible-dev-tools` packages and their versions
- Uses `adt --version` to fetch package information
- **Install** button to install `ansible-dev-tools` via the Python Environments API
- **Upgrade** button to upgrade with `pip install --upgrade --upgrade-strategy eager`
- **Refresh** button to reload the package list
- Auto-updates when the Python environment changes

#### Collections

- Lists installed Ansible collections alphabetically
- Expandable tree structure: Collection → Plugin Types → Plugins
- Plugin types show count (e.g., `modules (42)`)
- Collections show version in description and rich tooltip with authors and summary
- **Click a plugin** to open detailed documentation in a webview panel
- **Download** button to install collections from Ansible Galaxy
- **Refresh** button to reload installed collections
- **Database** button to refresh the Galaxy collections cache
- Auto-updates when the Python environment changes

#### Execution Environments

- Lists available container execution environments
- Uses `ansible-navigator images` to discover execution environments
- Expandable details for each EE:
  - **Info**: Ansible version, OS, image name
  - **Ansible Collections**: Installed collections with versions
  - **Python Packages**: Installed packages with versions
- **Refresh** button to reload the execution environments list

### Plugin Documentation Viewer

When you click on a plugin in the Collections tree, a documentation webview opens with:

- **Synopsis** - Description, requirements, and author information
- **Parameters** - Collapsible tree-style parameter list with types, defaults, choices, and descriptions
- **Notes** - Additional usage notes
- **Examples** - Task examples with:
  - Section headers based on task names or usage patterns
  - **Copy** button for each task
  - YAML syntax highlighting
  - Before/After state context blocks
  - **Formatted/Raw toggle** to switch between parsed and raw views
- **Return Values** - Documented return values with samples

#### Creator

- Tree view of `ansible-creator` commands (init, add)
- Expands to show all available subcommands (project, collection, plugin types)
- Click a leaf command to open a dynamic form with all parameters
- Form built from `ansible-creator schema` output
- Required/optional parameter sections with validation
- Run button executes the command in a terminal

#### MCP Tools

- Lists all available MCP tools for AI agent integration
- Categories: Discovery, Task Generation, Execution Environments, Dev Tools, Creator
- **Click a tool** to inject a prompt into Cursor/Copilot chat
- **Copy button** on each tool to copy the example prompt to clipboard
- Tools are dynamically discovered at runtime:
  - Static tools from the extension
  - Creator tools generated from `ansible-creator schema`
- Hover over a tool to see full description and parameters

### Galaxy Collection Cache

- Collections list from Ansible Galaxy is cached to the filesystem
- Cache auto-refreshes weekly (7 days)
- Progress shown in status bar during loading
- Manual refresh via the **Database** button in Collections view
- Search collections by namespace or name when installing

## MCP Server (AI Agent Integration)

The extension includes a standalone MCP (Model Context Protocol) server that exposes Ansible tools to AI agents like Cursor, VS Code Copilot, and other MCP-compatible clients.

### Available Tools

| Tool | Description |
|------|-------------|
| `search_ansible_plugins` | Search for plugins by keyword |
| `get_plugin_documentation` | Get full documentation for a plugin |
| `list_ansible_collections` | List installed collections |
| `generate_ansible_task` | Generate task YAML (one-shot) |
| `build_ansible_task` | Interactive task building with guided parameters |
| `generate_ansible_playbook` | Generate complete playbook |
| `list_execution_environments` | List available EEs |
| `get_ee_details` | Get EE collections and packages |
| `list_ansible_dev_tools` | List installed dev tools |
| `creator_*` | Dynamic tools from ansible-creator schema |

### Using with Cursor

**Automatic Configuration (Recommended):**

1. Open VS Code/Cursor with the extension installed
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run: **Ansible Environments: Configure Cursor MCP**
4. Choose between Global (all workspaces) or Workspace configuration
5. Restart Cursor

The command automatically detects the extension's location and configures the correct path.

**Check Status:**
Run **Ansible Environments: Show MCP Status** to see the current configuration and verify paths.

**Manual Configuration:**

If needed, add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ansible-environments": {
      "command": "node",
      "args": ["/absolute/path/to/extension/out/mcp/server.js"]
    }
  }
}
```

Note: The path must be absolute. Use the **Configure Cursor MCP** command to get the correct path automatically.

### Using with VS Code Copilot

The extension **automatically registers** as an MCP server provider when running in VS Code 1.99+. No configuration needed - Copilot will see the Ansible tools automatically.

The registration happens via `vscode.lm.registerMcpServerDefinitionProvider()` and provides:
- Automatic tool discovery by Copilot
- Stdio transport to the bundled MCP server
- Workspace-aware context

### Running Standalone

```bash
# From the extension directory
node out/mcp/server.js
```

### Example Agent Interactions

**Search for plugins:**
```
User: "How do I copy files in Ansible?"
Agent: search_ansible_plugins({ query: "copy file" })
→ ansible.builtin.copy, ansible.builtin.template, ...
```

**Generate a task:**
```
Agent: generate_ansible_task({
  plugin: "ansible.builtin.copy",
  params: { src: "app.conf", dest: "/etc/app/", mode: "0644" },
  become: true
})
→ Returns YAML task
```

**Interactive task building:**
```
Agent: build_ansible_task({ plugin: "ansible.builtin.apt" })
→ "Required: name. Optional: state, update_cache, ..."

Agent: build_ansible_task({ 
  session_id: "xxx", 
  params: { name: "nginx", state: "present" },
  generate: true 
})
→ Returns complete YAML task
```

## Requirements

- VS Code 1.85.0 or later
- [Microsoft Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension
- Python 3.9 or later
- For Execution Environments: `ansible-navigator` and a container runtime (Podman/Docker)

## Usage

1. Open a workspace folder in VS Code
2. Click the **Ansible Environments** icon in the Activity Bar
3. Select or create a Python environment from the **Environment Managers** view
4. Install `ansible-dev-tools` from the **Ansible Dev Tools** view
5. Browse installed collections and view plugin documentation
6. Install new collections from Ansible Galaxy

## Development

### Setup

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch
```

### Running the Extension

1. Press `F5` to open a new VS Code window with the extension loaded
2. Open a workspace folder
3. Click the Ansible Environments icon in the Activity Bar

### Building

```bash
# Package the extension
npx vsce package
```

## API Usage Examples

This extension demonstrates the following Python Environments API patterns:

### Getting the API

```typescript
const pythonEnvExtension = vscode.extensions.getExtension<PythonEnvironmentApi>(
    'ms-python.vscode-python-envs'
);
const api = pythonEnvExtension.exports;
```

### Getting the Current Environment

```typescript
const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
const environment = await api.getEnvironment(workspaceFolder);
```

### Setting an Environment

```typescript
await api.setEnvironment(workspaceFolder, environment);
```

### Creating an Environment

```typescript
const environment = await api.createEnvironment(workspaceFolder, {
    quickCreate: false
});
```

### Getting All Environments

```typescript
const allEnvironments = await api.getEnvironments('all');
```

### Installing Packages

```typescript
await api.managePackages(environment, {
    install: ['ansible-dev-tools'],
    upgrade: false
});
```

### Creating a Terminal with Environment

```typescript
const terminal = await api.createTerminal(environment, {
    name: 'Ansible Terminal',
    cwd: workspaceFolder
});
terminal.show();
terminal.sendText('ade install ansible.netcommon');
```

### Listening for Environment Changes

```typescript
api.onDidChangeEnvironment((event) => {
    console.log('Environment changed:', event.new?.displayName);
    // Refresh UI
});
```

## Extension Settings

This extension does not contribute any settings.

## Known Issues

- Galaxy API occasionally returns empty responses; the extension retries automatically
- Large collections may take a moment to index

## License

MIT
