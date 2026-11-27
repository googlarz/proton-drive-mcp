// No test may open a real macOS dialog: turn the channel off for everything that inherits this environment, and refuse to
// start osascript in this process even if a test forgets to inject its own runner.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

process.env.PROTON_DRIVE_DIALOG = "0";
for (const name of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  cp[name] = new Proxy(cp[name], {
    apply(target, self, args) {
      if (/(^|\/)osascript$/.test(String(args[0]))) throw new Error("test guard: a test tried to run osascript");
      return Reflect.apply(target, self, args);
    },
  });
}
syncBuiltinESMExports();
