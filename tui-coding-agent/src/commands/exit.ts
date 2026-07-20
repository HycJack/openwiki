/**
 * /exit — 退出程序
 */

import type { CommandEntry } from "./registry.js";

export const exitCommand: CommandEntry = {
  name: "exit",
  description: "Exit the application",
  handler: async (_args, ctx) => {
    ctx.chat.stop();
    process.exit(0);
  },
};
