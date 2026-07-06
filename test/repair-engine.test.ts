import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { repairToolInput, unwrapMarkdownAutoLinks } from "../src/repair-engine.ts";
import { REPAIR_CONFIGS } from "../src/tables.ts";

// Schemas mirroring pi's built-in tools (field names match dist/core/tools/*).
const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});
const bashSchema = Type.Object({
	command: Type.String(),
	timeout: Type.Optional(Type.Number()),
});
const editSchema = Type.Object({
	path: Type.String(),
	edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
});
const writeSchema = Type.Object({
	path: Type.String(),
	content: Type.String(),
});

describe("fast path", () => {
	test("valid input is returned by reference, untouched", () => {
		const input = { path: "/tmp/a.txt", limit: 10 };
		const result = repairToolInput({ toolName: "read", schema: readSchema, input, config: REPAIR_CONFIGS.read });
		expect(result.outcome).toBe("valid");
		expect(result.args).toBe(input);
		expect(result.notes).toEqual([]);
	});

	test("coercible input ('5' for number) is valid — pi's own Convert handles it", () => {
		const input = { path: "/tmp/a.txt", limit: "5" };
		const result = repairToolInput({ toolName: "read", schema: readSchema, input, config: REPAIR_CONFIGS.read });
		expect(result.outcome).toBe("valid");
		expect(result.args).toBe(input);
	});

	test("json-shaped file content is never rewritten", () => {
		const input = { path: "/tmp/a.json", content: '["a","b"]' };
		const result = repairToolInput({ toolName: "write", schema: writeSchema, input, config: REPAIR_CONFIGS.write });
		expect(result.outcome).toBe("valid");
		expect(result.args).toBe(input);
	});
});

describe("per-issue rules", () => {
	test("renames aliased field (file_path -> path)", () => {
		const result = repairToolInput({
			toolName: "read",
			schema: readSchema,
			input: { file_path: "/tmp/a.txt" },
			config: REPAIR_CONFIGS.read,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/tmp/a.txt" });
		expect(result.rulesFired).toEqual(["renameAliasedField"]);
		expect(result.notes[0]).toContain("file_path");
	});

	test("drops null for optional field", () => {
		const result = repairToolInput({
			toolName: "read",
			schema: readSchema,
			input: { path: "/tmp/a.txt", offset: null },
			config: REPAIR_CONFIGS.read,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/tmp/a.txt" });
		expect(result.rulesFired).toEqual(["dropNullOrUndefinedField"]);
	});

	test("drops empty {} placeholder where array expected", () => {
		const schema = Type.Object({ path: Type.String(), tags: Type.Optional(Type.Array(Type.String())) });
		const result = repairToolInput({ toolName: "x", schema, input: { path: "/a", tags: {} } });
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/a" });
		expect(result.rulesFired).toEqual(["dropEmptyObjectPlaceholder"]);
	});

	test("parses JSON-stringified array before bare-string wrapping", () => {
		const schema = Type.Object({ include: Type.Array(Type.String()) });
		const result = repairToolInput({ toolName: "x", schema, input: { include: '["a","b"]' } });
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ include: ["a", "b"] });
		expect(result.rulesFired).toEqual(["parseJsonStringifiedArray"]);
	});

	test("wraps bare string as single-element array", () => {
		const schema = Type.Object({ include: Type.Array(Type.String()) });
		const result = repairToolInput({ toolName: "x", schema, input: { include: "foo" } });
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ include: ["foo"] });
		expect(result.rulesFired).toEqual(["wrapBareStringAsArray"]);
	});

	test("repairs multiple issues in one pass", () => {
		const result = repairToolInput({
			toolName: "read",
			schema: readSchema,
			input: { file_path: "/tmp/a.txt", offset: null, limit: 5 },
			config: REPAIR_CONFIGS.read,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/tmp/a.txt", limit: 5 });
		expect(result.rulesFired).toContain("renameAliasedField");
		expect(result.rulesFired).toContain("dropNullOrUndefinedField");
	});
});

describe("root repairs", () => {
	test("wraps bare string as object for bash", () => {
		const result = repairToolInput({
			toolName: "bash",
			schema: bashSchema,
			input: "echo hi",
			config: REPAIR_CONFIGS.bash,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ command: "echo hi" });
		expect(result.rulesFired).toEqual(["wrapRootStringAsObject"]);
	});

	test("parses JSON-stringified root object", () => {
		const result = repairToolInput({
			toolName: "bash",
			schema: bashSchema,
			input: '{"command":"echo hi"}',
			config: REPAIR_CONFIGS.bash,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ command: "echo hi" });
		expect(result.rulesFired).toEqual(["parseJsonStringifiedRootObject"]);
	});
});

describe("markdown auto-links", () => {
	test("unwraps only the degenerate case", () => {
		expect(unwrapMarkdownAutoLinks("/home/x/[notes.md](http://notes.md)")).toBe("/home/x/notes.md");
		expect(unwrapMarkdownAutoLinks("[click](https://x.com)")).toBe("[click](https://x.com)");
	});

	test("unwraps auto-linked path field even when otherwise valid", () => {
		const result = repairToolInput({
			toolName: "read",
			schema: readSchema,
			input: { path: "/home/x/[notes.md](http://notes.md)" },
			config: REPAIR_CONFIGS.read,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/home/x/notes.md" });
		expect(result.rulesFired).toEqual(["unwrapMarkdownAutoLink"]);
	});

	test("does not touch non-path fields", () => {
		const content = "see [notes.md](http://notes.md)";
		const result = repairToolInput({
			toolName: "write",
			schema: writeSchema,
			input: { path: "/a.md", content },
			config: REPAIR_CONFIGS.write,
		});
		expect(result.outcome).toBe("valid");
	});
});

describe("edit structural repairs", () => {
	test("folds flat old_string/new_string into edits array", () => {
		const result = repairToolInput({
			toolName: "edit",
			schema: editSchema,
			input: { path: "/a.txt", old_string: "foo", new_string: "bar" },
			config: REPAIR_CONFIGS.edit,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/a.txt", edits: [{ oldText: "foo", newText: "bar" }] });
		expect(result.rulesFired).toContain("foldFlatEditFields");
	});

	test("renames aliased keys inside edits items", () => {
		const result = repairToolInput({
			toolName: "edit",
			schema: editSchema,
			input: { path: "/a.txt", edits: [{ old_string: "foo", new_string: "bar" }] },
			config: REPAIR_CONFIGS.edit,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/a.txt", edits: [{ oldText: "foo", newText: "bar" }] });
		expect(result.rulesFired).toEqual(["renameAliasedField"]);
	});

	test("combined: aliased path + flat aider-style search/replace", () => {
		const result = repairToolInput({
			toolName: "edit",
			schema: editSchema,
			input: { file_path: "/a.txt", search: "foo", replace: "bar" },
			config: REPAIR_CONFIGS.edit,
		});
		expect(result.outcome).toBe("repaired");
		expect(result.args).toEqual({ path: "/a.txt", edits: [{ oldText: "foo", newText: "bar" }] });
	});
});

describe("unrepairable input", () => {
	test("returns original input with no notes", () => {
		const input = { nothing: "useful" };
		const result = repairToolInput({ toolName: "read", schema: readSchema, input, config: REPAIR_CONFIGS.read });
		expect(result.outcome).toBe("unrepairable");
		expect(result.args).toBe(input);
		expect(result.notes).toEqual([]);
		expect(result.fingerprint).toBeDefined();
		expect(result.issueSummary).toContain("required");
	});

	test("provides a model-readable retry message", () => {
		const result = repairToolInput({
			toolName: "write",
			schema: writeSchema,
			input: { path: "/a.txt", content: null },
			config: REPAIR_CONFIGS.write,
		});
		expect(result.outcome).toBe("unrepairable");
		expect(result.retryMessage).toContain('Invalid input for tool "write"');
		expect(result.retryMessage).toContain("Received:");
	});

	test("fingerprint is stable for the same failure shape", () => {
		const a = repairToolInput({ toolName: "read", schema: readSchema, input: { x: 1 }, config: REPAIR_CONFIGS.read });
		const b = repairToolInput({ toolName: "read", schema: readSchema, input: { x: 2 }, config: REPAIR_CONFIGS.read });
		expect(a.fingerprint).toBe(b.fingerprint);
	});
});
