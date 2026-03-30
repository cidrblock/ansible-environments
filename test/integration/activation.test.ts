import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "cidrblock.ansible-environments";

suite("Ansible Environments Extension", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (ext && !ext.isActive) {
      await ext.activate();
    }
  });

  test("extension is installed", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension ${EXTENSION_ID} should be installed`);
  });

  test("extension activates successfully", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, "Extension should be active");
  });

  test("registers expected commands", async () => {
    const commands = await vscode.commands.getCommands(true);

    const expectedPrefixes = [
      "ansibleDevToolsPackages",
      "ansibleDevToolsCollections",
      "ansibleCreator",
      "ansiblePlaybooks",
    ];

    for (const prefix of expectedPrefixes) {
      const found = commands.some((cmd) => cmd.startsWith(prefix));
      assert.ok(found, `Should register commands with prefix "${prefix}"`);
    }
  });

  test("contributes ansible-environments view container", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const pkg = ext?.packageJSON;

    const viewContainers = pkg?.contributes?.viewsContainers?.activitybar;
    const container = viewContainers?.find(
      (c: { id: string }) => c.id === "ansible-environments",
    );
    assert.ok(container, "Should contribute ansible-environments view container");
  });

  test("contributes expected tree views", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const pkg = ext?.packageJSON;

    const views = pkg?.contributes?.views?.["ansible-environments"];
    assert.ok(views, "Should contribute views under ansible-environments");

    const expectedViewIds = [
      "ansibleDevToolsEnvManagers",
      "ansibleDevToolsPackages",
      "ansibleDevToolsCollections",
      "ansibleCollectionSources",
      "ansibleExecutionEnvironments",
      "ansibleCreator",
      "ansiblePlaybooks",
    ];

    for (const viewId of expectedViewIds) {
      const found = views.some((v: { id: string }) => v.id === viewId);
      assert.ok(found, `Should contribute view "${viewId}"`);
    }
  });

  test("contributes extension settings", () => {
    const config = vscode.workspace.getConfiguration("ansibleEnvironments");
    assert.notStrictEqual(config, undefined, "Should contribute ansibleEnvironments settings");
  });
});
