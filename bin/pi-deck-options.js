"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  return {
    // Pi Deck 产品默认 31415；30141 留给上游 pi-web，避免同机抢端口。
    port: cliArgs.port ?? env.PORT ?? "31415",
    hostname: cliArgs.hostname ?? env.HOSTNAME ?? null,
    // PI_DECK_NO_OPEN 为产品正式变量；PI_WEB_NO_OPEN 兼容旧用户。
    openBrowser:
      !cliArgs["no-open"] &&
      !isEnabled(env.PI_DECK_NO_OPEN) &&
      !isEnabled(env.PI_WEB_NO_OPEN),
  };
}

module.exports = { parseLaunchOptions };
