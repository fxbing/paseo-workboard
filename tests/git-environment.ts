import { join } from "node:path";

export function isolatedGitEnvironment(template: string): NodeJS.ProcessEnv {
  // Git treats missing config files as empty; Windows device paths can fail.
  const emptyConfig = join(template, "disabled-config");
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
    ),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: template,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: template,
    GIT_CONFIG_KEY_1: "core.excludesFile",
    GIT_CONFIG_VALUE_1: emptyConfig,
    GIT_CONFIG_KEY_2: "core.attributesFile",
    GIT_CONFIG_VALUE_2: emptyConfig,
  };
}
