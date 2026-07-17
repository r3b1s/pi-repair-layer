import { unwrapMarkdownAutoLinks } from "./repair-engine.ts";
import type { RepairChange } from "./types.ts";

export type ObjectLocationSelector = `/${string}` | "";

export type Preprocessor =
  | AliasPreprocessor
  | FieldPreprocessor
  | StructuralPreprocessor;

export interface AliasPreprocessor {
  kind: "alias";
  selector: ObjectLocationSelector;
  aliases: readonly string[];
  accepts?: "string" | "number" | "boolean" | "array" | "object";
  emptyEquivalentToMissing?: boolean;
}

export interface FieldPreprocessor {
  kind:
    | "filesystem-path"
    | "filesystem-path-array"
    | "glob"
    | "string-or-array"
    | "scalar"
    | "anchor-bleed"
    | "grammar-tokens";
  selector: ObjectLocationSelector;
  scalarType?: "string" | "number" | "boolean";
  modelFamilies?: readonly RegExp[];
}

export interface StructuralPreprocessor {
  kind: "structural";
  selector: ObjectLocationSelector;
  ruleId: string;
  apply: (value: unknown) => { value: unknown; note: string } | undefined;
}

interface Location {
  parent: Record<string, unknown> | unknown[] | undefined;
  key: string | number | undefined;
  value: unknown;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function locationsAt(
  root: unknown,
  selector: ObjectLocationSelector,
): Location[] {
  if (selector === "" || selector === "/") {
    return [{ parent: undefined, key: undefined, value: root }];
  }
  const segments = selector.split("/").slice(1).map(decodePointerSegment);
  let locations: Location[] = [
    { parent: undefined, key: undefined, value: root },
  ];
  for (const segment of segments) {
    const next: Location[] = [];
    for (const location of locations) {
      if (segment === "*") {
        if (Array.isArray(location.value)) {
          location.value.forEach((value, key) => {
            next.push({ parent: location.value as unknown[], key, value });
          });
        }
        continue;
      }
      if (
        location.value !== null &&
        typeof location.value === "object" &&
        !Array.isArray(location.value)
      ) {
        const parent = location.value as Record<string, unknown>;
        next.push({ parent, key: segment, value: parent[segment] });
      }
    }
    locations = next;
  }
  return locations;
}

function accepts(
  value: unknown,
  expected: AliasPreprocessor["accepts"],
): boolean {
  if (expected === undefined) return value !== null && value !== undefined;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  return typeof value === expected;
}

function setLocation(location: Location, value: unknown): boolean {
  if (location.parent === undefined || location.key === undefined) return false;
  if (Array.isArray(location.parent) && typeof location.key === "number") {
    location.parent[location.key] = value;
  } else if (
    !Array.isArray(location.parent) &&
    typeof location.key === "string"
  ) {
    location.parent[location.key] = value;
  } else {
    return false;
  }
  location.value = value;
  return true;
}

function stripAnchors(value: string): string {
  return value.replace(/^\^+/, "").replace(/\$+$/, "");
}

const GRAMMAR_TOKENS =
  /^(?:<arg_key>|<arg_value>)|(?:<\/arg_key>|<\/arg_value>)$/g;

function stripGrammarTokens(value: string): string {
  return value.replace(GRAMMAR_TOKENS, "").trim();
}

function modelMatches(
  modelId: string | undefined,
  families?: readonly RegExp[],
) {
  return Boolean(modelId && families?.some((family) => family.test(modelId)));
}

function note(ruleId: string, text: string): RepairChange {
  return { ruleId, stage: "preprocess", note: text };
}

export function preprocessInput(options: {
  input: unknown;
  toolName: string;
  preprocessors: readonly Preprocessor[];
  modelId?: string;
  allowValidValueTransforms: boolean;
}): { value: unknown; changes: RepairChange[]; observations: string[] } {
  const { toolName, preprocessors, modelId, allowValidValueTransforms } =
    options;
  let value = structuredClone(options.input);
  const changes: RepairChange[] = [];
  const observations: string[] = [];

  for (const preprocessor of preprocessors) {
    if (preprocessor.kind === "alias") {
      const parts = preprocessor.selector.split("/");
      const canonical = decodePointerSegment(parts.pop() ?? "");
      const parentSelector = (parts.join("/") || "/") as ObjectLocationSelector;
      for (const parentLocation of locationsAt(value, parentSelector)) {
        const parent = parentLocation.value;
        if (
          parent === null ||
          typeof parent !== "object" ||
          Array.isArray(parent)
        ) {
          continue;
        }
        const record = parent as Record<string, unknown>;
        const canonicalValue = record[canonical];
        const replaceEmpty =
          preprocessor.emptyEquivalentToMissing === true &&
          canonicalValue === "";
        if (
          canonical in record &&
          canonicalValue !== undefined &&
          canonicalValue !== null &&
          !replaceEmpty
        ) {
          continue;
        }
        for (const alias of preprocessor.aliases) {
          if (
            !(alias in record) ||
            !accepts(record[alias], preprocessor.accepts)
          ) {
            continue;
          }
          if (record[alias] === "") continue;
          record[canonical] = record[alias];
          delete record[alias];
          changes.push(
            note(
              "preprocess.exact-alias",
              `Renamed \`${alias}\` to \`${canonical}\` for tool "${toolName}". Use \`${canonical}\` next time.`,
            ),
          );
          break;
        }
      }
      continue;
    }

    if (preprocessor.kind === "structural") {
      for (const location of locationsAt(value, preprocessor.selector)) {
        const result = preprocessor.apply(location.value);
        if (!result) continue;
        if (location.parent === undefined) value = result.value;
        else setLocation(location, result.value);
        changes.push(note(preprocessor.ruleId, result.note));
      }
      continue;
    }

    const heuristic =
      preprocessor.kind === "anchor-bleed" ||
      preprocessor.kind === "grammar-tokens";
    if (heuristic && !modelMatches(modelId, preprocessor.modelFamilies))
      continue;

    for (const location of locationsAt(value, preprocessor.selector)) {
      const current = location.value;
      let next: unknown = current;
      if (
        preprocessor.kind === "filesystem-path" &&
        typeof current === "string"
      ) {
        next = unwrapMarkdownAutoLinks(current);
      } else if (
        preprocessor.kind === "filesystem-path-array" &&
        Array.isArray(current)
      ) {
        next = current.map((item) =>
          typeof item === "string" ? unwrapMarkdownAutoLinks(item) : item,
        );
      } else if (
        preprocessor.kind === "string-or-array" &&
        typeof current === "string"
      ) {
        next = [current];
      } else if (preprocessor.kind === "scalar") {
        if (
          preprocessor.scalarType === "string" &&
          ["number", "boolean"].includes(typeof current)
        ) {
          next = String(current);
        } else if (
          preprocessor.scalarType === "number" &&
          typeof current === "string" &&
          current.trim() !== ""
        ) {
          const parsed = Number(current);
          if (Number.isFinite(parsed)) next = parsed;
        } else if (
          preprocessor.scalarType === "boolean" &&
          typeof current === "string" &&
          /^(?:true|false)$/i.test(current)
        ) {
          next = current.toLowerCase() === "true";
        }
      } else if (
        preprocessor.kind === "anchor-bleed" &&
        typeof current === "string"
      ) {
        next = stripAnchors(current);
      } else if (preprocessor.kind === "grammar-tokens") {
        if (typeof current === "string") {
          next = stripGrammarTokens(current);
        } else if (
          current !== null &&
          typeof current === "object" &&
          !Array.isArray(current)
        ) {
          const record = Object.create(null) as Record<string, unknown>;
          for (const [key, item] of Object.entries(current)) {
            const cleanKey = stripGrammarTokens(key);
            record[cleanKey] =
              typeof item === "string" ? stripGrammarTokens(item) : item;
          }
          next = record;
        }
      }

      if (
        Object.is(next, current) ||
        JSON.stringify(next) === JSON.stringify(current)
      ) {
        continue;
      }
      const ruleId =
        preprocessor.kind === "anchor-bleed"
          ? "stripAnchorBleed"
          : preprocessor.kind === "grammar-tokens"
            ? "stripGrammarTokenLeak"
            : `preprocess.${preprocessor.kind}`;
      if (heuristic && !allowValidValueTransforms) {
        if (!observations.includes(ruleId)) observations.push(ruleId);
        continue;
      }
      if (location.parent === undefined) value = next;
      else setLocation(location, next);
      changes.push(
        note(
          ruleId,
          preprocessor.kind === "anchor-bleed"
            ? `Stripped leaked regex anchors (\`^\` / \`$\`) from a configured value for tool "${toolName}".`
            : preprocessor.kind === "grammar-tokens"
              ? `Removed leaked grammar tokens (\`<arg_key>\`/\`<arg_value>\`) from configured keys or values for tool "${toolName}".`
              : preprocessor.kind === "filesystem-path" ||
                  preprocessor.kind === "filesystem-path-array"
                ? `Unwrapped a markdown auto-link at ${preprocessor.selector || "/"} for tool "${toolName}". Send plain filesystem paths, not markdown links.`
                : `Applied configured ${preprocessor.kind} preprocessing at ${preprocessor.selector || "/"} for tool "${toolName}".`,
        ),
      );
    }
  }

  return { value, changes, observations };
}
