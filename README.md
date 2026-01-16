# Ansible Environments

A VS Code extension for managing Ansible development environments, leveraging the [Microsoft Python Environments extension](https://github.com/microsoft/vscode-python-environments) API.

## Features

### Sidebar Views

The extension adds an **Ansible Environments** panel to the VS Code Activity Bar with four collapsible views:

#### 🐍 Environment Managers

- Lists all available Python environments grouped by manager type (venv, Global, Conda, etc.)
- Click an environment to set it as the active Python environment for the workspace
- Checkmark icon indicates the currently selected environment
- **+** button to create a new Python environment
- **Refresh** button to reload the environment list
- Auto-updates when the Python environment changes

#### 📦 Ansible Dev Tools

- Displays installed `ansible-dev-tools` packages and their versions
- Uses `adt --version` to fetch package information
- **Install** button to install `ansible-dev-tools` via the Python Environments API
- **Upgrade** button to upgrade with `pip install --upgrade --upgrade-strategy eager`
- **Refresh** button to reload the package list
- Auto-updates when the Python environment changes

#### 📚 Collections

- Lists installed Ansible collections alphabetically
- Expandable tree structure: Collection → Plugin Types → Plugins
- Plugin types show count (e.g., `modules (42)`)
- Collections show version in description and rich tooltip with authors and summary
- **Click a plugin** to open detailed documentation in a webview panel
- **Download** button to install collections from Ansible Galaxy
- **Refresh** button to reload installed collections
- **Database** button to refresh the Galaxy collections cache
- Auto-updates when the Python environment changes

#### 🐳 Execution Environments

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

### Galaxy Collection Cache

- Collections list from Ansible Galaxy is cached to the filesystem
- Cache auto-refreshes weekly (7 days)
- Progress shown in status bar during loading
- Manual refresh via the **Database** button in Collections view
- Search collections by namespace or name when installing

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
