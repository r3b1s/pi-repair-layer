export type RepairPolicyProfile = "conservative" | "adaptive" | "recover";

export type GrammarPolicyMode = "off" | "observe" | "strip" | "recover";

export type UnknownGrammarTextPolicy = "preserve" | "strip";

export interface RepairPolicy {
  profile: RepairPolicyProfile;
  allowTruncatedEnvelopeCompletion: boolean;
  allowValidValueTransforms: boolean;
  grammarMode: GrammarPolicyMode;
  unknownGrammarText: UnknownGrammarTextPolicy;
}

export interface RepairPolicyOverrides {
  grammarMode?: GrammarPolicyMode;
  unknownGrammarText?: UnknownGrammarTextPolicy;
}

const PROFILE_DEFAULTS: Record<RepairPolicyProfile, RepairPolicy> = {
  conservative: {
    profile: "conservative",
    allowTruncatedEnvelopeCompletion: false,
    allowValidValueTransforms: false,
    grammarMode: "observe",
    unknownGrammarText: "preserve",
  },
  adaptive: {
    profile: "adaptive",
    allowTruncatedEnvelopeCompletion: true,
    allowValidValueTransforms: true,
    grammarMode: "strip",
    unknownGrammarText: "preserve",
  },
  recover: {
    profile: "recover",
    allowTruncatedEnvelopeCompletion: true,
    allowValidValueTransforms: true,
    grammarMode: "recover",
    unknownGrammarText: "preserve",
  },
};

export function resolveRepairPolicy(
  profile: RepairPolicyProfile = "adaptive",
  overrides: RepairPolicyOverrides = {},
): RepairPolicy {
  return {
    ...PROFILE_DEFAULTS[profile],
    ...overrides,
    profile,
  };
}
