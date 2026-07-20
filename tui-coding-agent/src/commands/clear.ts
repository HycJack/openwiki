/**
 * /clear — 清屏
 */

import type { CommandEntry } from "./registry.js";

export const clearCommand: CommandEntry = {
  name: "clear",
  description: "Clear screen",
  handler: async () => {
    process.stdout.write("\x1b[2J\x1b[H");
  },
};
