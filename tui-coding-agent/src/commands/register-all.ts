/**
 * 注册所有内置命令到 CommandRegistry
 */

import { CommandRegistry } from "./registry.js";
import { exitCommand } from "./exit.js";
import { helpCommand } from "./help.js";
import { clearCommand } from "./clear.js";
import { modelCommand } from "./model.js";
import { tokensCommand } from "./tokens.js";
import { ctxCommand } from "./ctx.js";
import { compactCommand } from "./compact.js";
import { sessionsCommand, sessionCommand, treeCommand, forkCommand } from "./session.js";

export function registerAllCommands(registry: CommandRegistry): void {
  registry.register(exitCommand);
  registry.register(helpCommand);
  registry.register(clearCommand);
  registry.register(modelCommand);
  registry.register(tokensCommand);
  registry.register(ctxCommand);
  registry.register(compactCommand);
  registry.register(sessionsCommand);
  registry.register(sessionCommand);
  registry.register(treeCommand);
  registry.register(forkCommand);
}
