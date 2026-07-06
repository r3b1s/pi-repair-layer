# Prompt to Trigger the pi-repair-layer Extension

> Use this prompt with any LLM-powered coding agent (pi, Claude Code, aider, etc.) to elicit the full spectrum of malformed tool calls that the pi-repair-layer intercepts and fixes. The prompt is designed as a realistic multi-step development task, densely packed with the kinds of phrasing and patterns that open models frequently emit.

---

## The Prompt

```
I'm working on a small web project in ~/project. Here's what I need done:

1. Read through the main index.js file in the project root so you understand the current code structure.

2. Look at package.json to see what dependencies are listed.

3. In the src/components/ directory, find any file that mentions the word "deprecated" and show me what it says.

4. There's a bug in src/utils/helpers.js — the function `calculateTotal` has an off-by-one error. Open the file at file_path src/utils/helpers.js and fix it by replacing old_string `for (let i = 0; i <= items.length; i++)` with new_string `for (let i = 0; i < items.length; i++)`.

5. Also in that same helpers.js file, rename the function `oldFunctionName` to `newFunctionName` — replace old_string `function oldFunctionName` with new_string `function newFunctionName`.

6. Create a new file at file_path src/config.js with contents:
```
export const DEBUG = true;
export const VERSION = "2.0.0";
```

7. Write a bash command to install the dependencies — cd ~/project && npm install

8. Run all the tests with 'npm test' — execute the full test suite and show me the output. Use a timeout of 120 seconds so it doesn't get cut off.

9. Now edit index.js — rename the variable `appName` to `APP_NAME`. Use the edit tool with: file_path ~/project/index.js, old_string `const appName = "myApp"`, new_string `const APP_NAME = "myApp"`.

10. List the contents of the directory at directory_path ~/project/src to see the full file tree.

11. In the file ~/project/src/[notes.md](http://notes.md), there should be some documentation. Read it and summarize what the project does.

12. The dependency on 'lodash' is outdated. In package.json, query the lines that contain "lodash" and show them to me.

13. Search through src/ for any file that references the pattern "TODO" — use the regex "TODO|FIXME" and show me what you find.

14. grep for the command "deprecated-api" in the entire project at query src/ and report all occurrences.

15. In index.js, there's a config block near the top. Change the value "development" to "production" — use old_string `env: "development"` and new_string `env: "production"`.

16. Run disk usage (du -sh ~/project) to check the project size.

17. Let me see the project's git log — run git log --oneline -5 in ~/project.

18. One more edit in helpers.js: there's a JSON config object literal at the top of the file that got stringified. Replace the entire contents ~/project/src/utils/helpers.js with the cleaned-up version below (use write).

19. Actually, I sent that wrong — offset that last request. Instead, read ~/project/src/styles/main.css and show me line-by-line what the responsive breakpoints are, starting at offset 20 with a limit of 15 lines.

20. In index.js, I see you used the file_path notation earlier — good. Now do a few more renames in bulk: in index.js, replace query "baseUrl" with "BASE_URL", and replace query "apiVersion" with "API_VERSION". Actually wait — the include property should be an array of patterns: include '["*.js","*.ts"]'. Let me also set the exclude to null for now since we don't need to skip anything.

21. Also in package.json, set the "tags" field to {} for now — I'll fill in the actual array of tags later.

22. In helpers.js, there's a config object. Read the file at file_path src/utils/helpers.js and set the new options to {"recursive": true, "verbose": false} by passing the whole file_path with options as a string: '{"file_path":"src/utils/helpers.js", "options":"{\\"recursive\\": true, \\"verbose\\": false}"}'. Actually, let me simplify — just use grep with options '{"maxDepth": 3, "includeHidden": false}'.

23. Actually, for bash: do '{"command":"ls -la src/"}' as a JSON string.
```

---

## Why This Prompt Triggers Each Repair Rule

| # | Rule | How the prompt triggers it |
|---|---|---|
| 1–3 | `renameAliasedField` (`file_path` → `path`) | Steps 4, 6, 9 use `file_path` instead of `path` — the canonical Claude Code alias. Step 10 uses `directory_path` instead of `path` for `ls`. Steps 13–14 use `query`/`regex` instead of `pattern`/`command` for grep. Step 20 uses `file_path` again for edit. |
| 4 | `dropNullOrUndefinedField` | Step 20 sends `exclude: null` — a null-valued optional field that must be dropped. |
| 5 | `renameAliasedField` (`old_string` → `oldText`, `new_string` → `newText` in edits array) | Steps 4, 9, 15 use Claude Code's flat `old_string`/`new_string` pair at the top level of the edit call. |
| 6 | `foldFlatEditFields` + `renameAliasedField` | The aider-style flat `old_string`/`new_string` fields are folded into the `edits[{oldText, newText}]` array. |
| 7–8 | `wrapRootStringAsObject` | Steps 7 and 16–17 send bare strings to `bash` (e.g. `"cd ~/project && npm install"` instead of `{command: "..."}`). |
| 9 | `parseJsonStringifiedArray` | Step 20 sends `include: '["*.js","*.ts"]'` — a JSON-stringified array that must be parsed into a real array. |
| 10 | `wrapBareStringAsArray` | If the model just sends `include: "*.js"` as a bare string (fallback parse scenario), the rule wraps it in an array. |
| 11 | `unwrapMarkdownAutoLink` | Step 11 uses `[notes.md](http://notes.md)` in a path field — the degenerate markdown auto-link pattern. |
| 12 | `renameAliasedField` (`query` → `pattern`) | Step 12 uses `query` for grep, which is a common aider/Claude Code alias for `pattern`. |
| 13 | `renameAliasedField` (`regex` → `pattern` or `command` → dep. on tool) | Step 13 asks to use "regex" as the field name; the repair renames to the canonical field. |
| 14 | `renameAliasedField` (`query` → `pattern` + `command` → depends) | Step 14 uses both `query` and `command` in ways that alias to the schema's expected field. |
| 15 | `foldFlatEditFields` + `renameAliasedField` | Step 15 uses `old_string`/`new_string` flat fields for edit, which must be folded into the `edits` array format. |
| 16 | `wrapRootStringAsObject` | Bare string `"du -sh ~/project"` to bash gets wrapped as `{command: "du -sh ~/project"}`. |
| 17 | `wrapRootStringAsObject` | Same — bare string to bash. |
| 18 | `renameAliasedField` + `parseJsonStringifiedRootObject` | Step 18 uses write with `file_path` alias. |
| 19 | Benign validation (valid pattern) | Step 19 uses valid pi-style params (`offset`, `limit` as numbers) but provides a contrast — shows what a *correct* call looks like alongside the broken ones. |
| 20 | Multi-rule storm | Combines `file_path` alias, `include` with JSON-stringified array, `query` alias, and `null` for `exclude` — exercises rename, parse, and drop rules together. |
| 21 | `dropEmptyObjectPlaceholder` | Step 21 sends `tags: {}` where the schema expects an array — the repair drops the empty object placeholder. |
| 22 | `parseJsonStringifiedObject` | Step 22 sends a stringified JSON object for an object-typed field (`options`), which gets parsed. |
| 23 | `parseJsonStringifiedRootObject` | Step 23 passes a JSON string `'{"command":"ls -la src/"}'` as the entire `bash` input — the repair parses it into a real object. |

---

## Expected Repair Output

When the agent processes this prompt, the TUI/interaction log should show `<repair_note>` lines like:

```
<repair_note>Renamed `file_path` to `path` for tool "read". `file_path` is not a valid field for this tool — use `path` next time.</repair_note>
<repair_note>Renamed `old_string` to `oldText` for tool "edit". `old_string` is not a valid field for this tool — use `oldText` next time.</repair_note>
<repair_note>Folded flat `old_string`/`new_string` fields into `edits: [{oldText, newText}]` for tool "edit". This tool takes an array of edit objects — send `edits` next time.</repair_note>
<repair_note>Wrapped your bare string as `{command: "..."}` for tool "bash". Call this tool with a JSON object next time, not a bare string.</repair_note>
<repair_note>Parsed JSON-stringified array for `include` in tool "grep". Send the array literal directly (e.g. `["*.js","*.ts"]`) next time, not a string.</repair_note>
<repair_note>Unwrapped a markdown auto-link in `path` for tool "read" (`[notes.md](http://notes.md)` -> `notes.md`). Send plain paths, not markdown links.</repair_note>
<repair_note>Dropped null `exclude` from tool "grep". Omit optional fields entirely rather than sending null.</repair_note>
<repair_note>Dropped empty `{}` placeholder from `tags` for tool "edit". Send an actual array (or omit the field) next time.</repair_note>
<repair_note>Parsed JSON-stringified object for `options` in tool "grep". Send the object literal directly next time, not a string.</repair_note>
<repair_note>Parsed your JSON-stringified arguments for tool "bash". Send the arguments as a JSON object next time, not a string.</repair_note>
```

The `/repair-stats` command in pi's TUI should then show non-zero counts across multiple rules, tools, and (if a model ID was captured) per-model breakdowns.

---

## Verifying It Worked

After running this prompt through the agent:

```bash
# Check telemetry was recorded
cat ~/.pi/agent/tool-repair/telemetry.jsonl | bun -e "
  const lines = (await Bun.stdin.text()).split('\n').filter(Boolean);
  const records = lines.map(l => JSON.parse(l));
  const byRule = {};
  for (const r of records) for (const rule of r.rules) byRule[rule] = (byRule[rule] || 0) + 1;
  console.log('Total repairs:', records.length);
  console.log('By rule:', JSON.stringify(byRule, null, 2));
"

# Or in pi's TUI, just type:
/repair-stats
```

Expected: at least 6–10 repair events across 4+ different rules and 3+ different tools.
