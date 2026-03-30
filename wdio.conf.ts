/// <reference types="wdio-vscode-service" />
import path from "path";
import type { Options } from "@wdio/types";

export const config: Options.Testrunner = {
  runner: "local",
  autoCompileOpts: {
    tsNodeOpts: {
      project: "./test/e2e/tsconfig.json",
    },
  },
  specs: ["./test/e2e/**/*.test.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "vscode",
      browserVersion: "stable",
      "wdio:vscodeOptions": {
        extensionPath: path.resolve(__dirname),
        userSettings: {
          "editor.fontSize": 14,
        },
      },
    },
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: ["vscode"],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
