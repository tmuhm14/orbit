import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

/**
 * Evaluates a TypeScript module with its imports replaced, so route handlers
 * and server-only modules can be tested with in-memory doubles. Side-effect
 * imports (such as "server-only") are dropped; every named import must be
 * provided in `imports`. Returns the module's exported functions and consts.
 */
export function loadTs(path, imports = {}) {
  const exported = [];
  const code = stripTypeScriptTypes(readFileSync(path, "utf8"))
    .replace(/import\s+"[^"]+";/g, "")
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/g,
      (_, names, spec) =>
        `const {${names.replace(/\s+as\s+/g, ": ")}} = __import(${JSON.stringify(spec)});`,
    )
    .replace(
      /export\s+(async\s+function|function|const|let|class)\s+(\w+)/g,
      (_, kind, name) => {
        exported.push(name);
        return `${kind} ${name}`;
      },
    );
  const factory = new Function("__import", `${code}\nreturn { ${exported.join(", ")} };`);
  return factory((spec) => {
    if (!(spec in imports)) throw new Error(`Unmapped import ${spec} in ${path}`);
    return imports[spec];
  });
}
