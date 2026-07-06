/**
 * Repair configuration for pi's seven built-in tools.
 *
 * The alias lists encode the field names open models actually emit — mostly
 * leakage from the tool contracts they were RL-trained on (Claude Code's
 * `file_path`/`old_string`/`new_string`, aider's `search`/`replace`, generic
 * `cmd`/`query`). Aliases only ever apply when the canonical field is missing
 * or undefined at a path the validator flagged, so valid calls never pay for
 * this table.
 */

import type { StructuralRepair, ToolRepairConfig } from "./repair-engine.ts";

const PATH_ALIASES = [
	"file_path",
	"filePath",
	"filepath",
	"absolute_path",
	"absolutePath",
	"pathname",
	"file",
	"filename",
	"fileName",
	"target_file",
	"targetFile",
] as const;

const OLD_TEXT_ALIASES = [
	"old_string",
	"oldString",
	"old_str",
	"oldStr",
	"old_text",
	"oldValue",
	"old_value",
	"oldContent",
	"old_content",
	"old",
	"from",
	"search",
] as const;

const NEW_TEXT_ALIASES = [
	"new_string",
	"newString",
	"new_str",
	"newStr",
	"new_text",
	"newValue",
	"new_value",
	"newContent",
	"new_content",
	"new",
	"to",
	"replace",
] as const;

/**
 * pi's `edit` takes `edits: [{ oldText, newText }]`, but models trained on
 * single-edit contracts send the pair flat at the top level (usually as
 * `old_string`/`new_string`). Field renames alone can't fix that — the pair
 * has to move into an array element — so this runs as a structural repair.
 * pi's own built-in shim already folds a flat `oldText`/`newText` pair; this
 * extends the same fold to the aliased spellings.
 */
const foldFlatEditFields: StructuralRepair = {
	name: "foldFlatEditFields",
	apply(args, toolName) {
		if (Array.isArray(args.edits) && args.edits.length > 0) return false;
		const oldKey = ["oldText", ...OLD_TEXT_ALIASES].find((key) => typeof args[key] === "string");
		const newKey = ["newText", ...NEW_TEXT_ALIASES].find((key) => typeof args[key] === "string");
		if (oldKey === undefined || newKey === undefined) return false;
		const edit = { oldText: args[oldKey], newText: args[newKey] };
		for (const key of ["oldText", "newText", ...OLD_TEXT_ALIASES, ...NEW_TEXT_ALIASES]) {
			delete args[key];
		}
		args.edits = [edit];
		return `Folded flat \`${oldKey}\`/\`${newKey}\` fields into \`edits: [{oldText, newText}]\` for tool "${toolName}". This tool takes an array of edit objects — send \`edits\` next time.`;
	},
};

export const REPAIR_CONFIGS: Record<string, ToolRepairConfig> = {
	read: {
		fieldAliases: { path: PATH_ALIASES },
		rootString: { field: "path" },
		pathFields: ["path"],
	},
	bash: {
		fieldAliases: {
			command: ["cmd", "script", "shell", "bash_command", "bashCommand", "command_line", "commandLine"],
		},
		rootString: { field: "command" },
	},
	edit: {
		fieldAliases: {
			path: PATH_ALIASES,
			edits: ["changes", "replacements", "modifications", "operations"],
			oldText: OLD_TEXT_ALIASES,
			newText: NEW_TEXT_ALIASES,
		},
		pathFields: ["path"],
		structural: [foldFlatEditFields],
	},
	write: {
		fieldAliases: {
			path: PATH_ALIASES,
			content: [
				"text",
				"body",
				"data",
				"contents",
				"file_content",
				"fileContent",
				"file_text",
				"fileText",
				"new_content",
				"newContent",
			],
		},
		pathFields: ["path"],
	},
	grep: {
		fieldAliases: {
			pattern: ["query", "regex", "search", "q", "expression", "search_pattern", "searchPattern"],
		},
		rootString: { field: "pattern" },
		pathFields: ["path"],
	},
	find: {
		fieldAliases: {
			pattern: ["glob", "query", "name_pattern", "namePattern", "file_pattern", "filePattern", "search", "name"],
		},
		rootString: { field: "pattern" },
		pathFields: ["path"],
	},
	ls: {
		fieldAliases: {
			path: ["directory", "dir", "folder", "directory_path", "directoryPath", ...PATH_ALIASES],
		},
		rootString: { field: "path" },
		pathFields: ["path"],
	},
};
