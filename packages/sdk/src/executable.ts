import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Keep bundled helpers beside their executable when a PATH entry is a symlink. */
export function resolveExecutable(command: string): string {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [resolve(command)]
    : (process.env.PATH ?? "").split(delimiter).flatMap(directory => {
      const path = join(directory || process.cwd(), command);
      return process.platform === "win32" && !/\.[^\\/]+$/.test(command)
        ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(extension => path + extension)
        : [path];
    });
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return realpathSync(path); }
    catch { /* Let the process launcher report a missing command. */ }
  }
  return command;
}
