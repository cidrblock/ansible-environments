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

  it("should show tree views in the sidebar", async () => {
    const workbench = await browser.getWorkbench();
    const activityBar = workbench.getActivityBar();

    const ansibleControl = await activityBar.getViewControl(
      "Ansible Environments",
    );
    const sidebarView = await ansibleControl!.openView();

    const content = sidebarView.getContent();
    const sections = await content.getSections();

    expect(sections.length).toBeGreaterThan(0);

    const sectionTitles = await Promise.all(
      sections.map((s) => s.getTitle()),
    );

    expect(sectionTitles).toContain("Environment Managers");
    expect(sectionTitles).toContain("Ansible Dev Tools");
    expect(sectionTitles).toContain("Installed Collections");
  });
});
