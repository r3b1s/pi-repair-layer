import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { runRepairPipeline } from "./pipeline.ts";
import type { RepairPipelineConfig, RepairPipelineResult } from "./types.ts";

export class UnrepairableToolInputError extends Error {
  readonly result: RepairPipelineResult;

  constructor(result: RepairPipelineResult) {
    super(result.retryMessage ?? "Tool input could not be repaired safely.");
    this.name = "UnrepairableToolInputError";
    this.result = result;
  }
}

export interface PiToolOwnerAdapterOptions
  extends Omit<
    RepairPipelineConfig,
    "toolName" | "schema" | "ownerPrepareArguments"
  > {
  /** Receive structured outcomes without giving the pure core side effects. */
  onOutcome?: (result: RepairPipelineResult) => void;
  /** Default is fail-closed by throwing a model-readable error. */
  unrepairable?: "throw" | "passthrough";
}

/**
 * Wrap a definition explicitly supplied by its owning extension. This adapter
 * never discovers, scans, or replaces tools registered by other extensions.
 */
export function adaptToolDefinition<
  TParams extends TSchema,
  TDetails = unknown,
  TState = unknown,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  options: PiToolOwnerAdapterOptions = {},
): ToolDefinition<TParams, TDetails, TState> {
  const ownerPrepareArguments = definition.prepareArguments;
  return {
    ...definition,
    prepareArguments(input: unknown): Static<TParams> {
      const result = runRepairPipeline({
        input,
        config: {
          ...options,
          toolName: definition.name,
          schema: definition.parameters,
          ownerPrepareArguments,
        },
      });
      if (result.outcome === "unrepairable") {
        if (options.unrepairable === "passthrough") {
          return input as Static<TParams>;
        }
        throw new UnrepairableToolInputError(result);
      }
      return result.args as Static<TParams>;
    },
  };
}
