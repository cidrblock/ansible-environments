import { browser } from "@wdio/globals";

describe("Ansible Environments Extension", () => {
  it("should activate and show the sidebar", async () => {
    const workbench = await browser.getWorkbench();
    const activityBar = workbench.getActivityBar();

    const viewControls = await activityBar.getViewControls();
    const titles = await Promise.all(viewControls.map((vc) => vc.getTitle()));

    expect(titles).toContain("Ansible Environments");
  });

  it("should open the Ansible Environments sidebar", async () => {
    const workbench = await browser.getWorkbench();
    const activityBar = workbench.getActivityBar();

    const ansibleControl = await activityBar.getViewControl(
      "Ansible Environments",
    );
    expect(ansibleControl).toBeDefined();

    const sidebarView = await ansibleControl!.openView();
    expect(sidebarView).toBeDefined();
  });

  it("should have sidebar sections", async () => {
    const workbench = await browser.getWorkbench();
    const activityBar = workbench.getActivityBar();

    const ansibleControl = await activityBar.getViewControl(
      "Ansible Environments",
    );
    const sidebarView = await ansibleControl!.openView();

    const content = sidebarView.getContent();
    const sections = await content.getSections();

    // The extension declares 7+ view containers in package.json.
    // Without ms-python.vscode-python-envs installed, the extension
    // cannot fully activate, so section titles may be null. We only
    // verify VS Code created the container sections from static
    // package.json contributions.
    expect(sections.length).toBeGreaterThan(0);
  });
});
