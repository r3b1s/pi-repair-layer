## ADDED Requirements

### Requirement: Graceful degradation across version skew
The preprocessing pipeline SHALL ignore configured preprocessor entries whose `kind` it does not recognize — applying no mutation, raising no error, and recording no change for them — and the final result SHALL still be validated against the supplied schema. This behavior is a compatibility guarantee: a consumer configured against a newer options shape SHALL degrade to the recognized subset when running against an older installed version of the package.

#### Scenario: Unknown preprocessor kind is ignored
- **WHEN** a repair configuration includes a preprocessor entry whose `kind` the installed version does not implement, alongside recognized entries
- **THEN** the recognized entries apply, the unknown entry produces no mutation, error, or claimed change, and the result must still pass schema validation

#### Scenario: Skewed consumer stays functional
- **WHEN** a consumer built against a newer minor version of the options types runs with an older installed package
- **THEN** repair proceeds using the subset of configuration the installed version recognizes, without throwing at configuration time
