# Farm Context Reliability and Knowledge

**Status:** Proposed; awaiting user approval

**Scope:** Specification only. No implementation is authorized by this document.

## Recommendation

Improve the existing farm profile first so farmers can maintain it and experts receive every relevant saved value consistently. Treat a persistent, field-level farm knowledge base as a later phase because the current product does not define which records, documents, or farm structures it must support.

## Current behavior and second-look findings

- `farm_profiles` stores one profile per user: name, location, coordinates, whole-number acres, crop names, soil type, water source, climate zone, and hardiness zone.
- The home page opens the profile dialog when no profile exists, but offers no persistent way to reopen it after saving.
- The dialog suppresses profile-load errors. If reused for editing, a failed load could leave a blank form that a farmer could save over existing values.
- The streaming expert path only builds farm context when location or crops are set. Other populated values are skipped when both are absent; weather lookup is inside that same condition.
- The non-streaming response function omits farm and weather context. The current orchestrator uses streaming, but the two response paths can drift.
- The farm prompt asks experts to reference all major profile categories in every answer, even when some are blank or irrelevant.
- Latitude and longitude are stored as text and have no server-side numeric/range or pair validation. The UI truncates acreage to an integer, matching the database type.
- Conversation history is limited to the latest 15 messages in the model prompt. Uploaded files are conversation-scoped, and the prompt builder considers at most 10 files. Neither provides durable farm-wide memory.

## Phase 1: Make the existing profile reliable

### Profile management

1. Add a persistent **Farm profile** entry point available whether the farmer has a profile or not.
2. Allow creating and editing the existing profile through the same form.
3. Show loading and load-error states. Do not allow an existing profile to be saved from an empty form when its load failed. Preserve the current unsaved-changes confirmation and refresh the farm-profile query after a successful save.
4. Keep the profile scoped to the authenticated user. Continue deriving the user ID from the session and whitelisting accepted API fields.

### Validation and stored values

1. Validate coordinates on the server as a numeric latitude in `[-90, 90]` and longitude in `[-180, 180]`; require both values or neither. The form must allow clearing both.
2. Do not send raw latitude/longitude to model providers. Use the pair for server-side weather lookup only.
3. Decide and document acreage precision before changing the schema. The current UI silently floors decimal input. The recommendation is to preserve fractional acres if small or partial-acre operations are in scope; that requires a database type change and migration.

### Expert context

1. Build farm context from every meaningful, populated profile field. Location or crops must not be prerequisites. Omit empty/default values rather than presenting them as facts.
2. Fetch weather whenever a valid coordinate pair is present, independently of whether other farm fields are populated. Keep current cache behavior and graceful degradation when weather is unavailable.
3. Use one shared context-building path for streaming and non-streaming expert responses so their behavior remains aligned.
4. Label profile details as farmer-provided and include the profile's last-updated date. Do not imply independent verification or field measurement.
5. Tell experts to use relevant known facts, avoid inventing missing facts, and ask when necessary. Do not require them to mention every profile field in each response.
6. Preserve the existing owner boundary: an expert receives only the profile belonging to its conversation's user.

### Phase 1 acceptance checks

- A profile containing only acreage, soil, water, or climate details reaches the prompt.
- A coordinates-only profile can provide weather context; missing or invalid coordinates do not prevent other profile details from being used.
- Empty/default fields are omitted, and the prompt does not require irrelevant profile details to be repeated.
- Streaming and non-streaming prompt construction produce the same farm and weather context.
- Invalid, out-of-range, or half-complete coordinate pairs are rejected by the API; clearing both is accepted.
- An authenticated farmer can reopen, edit, and save the profile. A failed profile load is visible and cannot result in a destructive blank save.
- Tests cover profile ownership, sparse-profile context, weather gating, validation, and the edit/load-error flow.

## Phase 2: Durable farm knowledge (separate approval)

If “all information about the farm” means more than a farm-wide summary, define a separate model for farms, fields, and seasonal plans. Records should have a scope (farm, field, or season), source, and date so experts can distinguish current farmer facts from older or unverified information. Farm-level reference documents could then persist across conversations and be retrieved by relevance, rather than placing every document in every prompt.

This phase needs a product decision on single-farm versus multi-farm accounts, the record types farmers need, document retention/deletion, and whether a conversation can select or exclude a farm. It should not be approximated by an unbounded profile text field or by copying every stored document into every expert request.

## Decisions requested before implementation

1. **Phase 1 account scope:** retain the current one-farm-per-user assumption, or include multiple farms now? Recommendation: retain one farm for Phase 1 and scope multi-farm support separately.
2. **Acreage precision:** keep whole acres, or support fractional acres with a schema migration? Recommendation: support decimals if partial-acre operations are in scope.
3. **Context scope:** continue automatically applying the profile to every conversation for that user, or add a per-conversation include/exclude control? Recommendation: retain current automatic behavior for Phase 1 and clearly disclose it in the profile UI; add a toggle only if farmers need conversation-level control.
4. **Phase 2:** approve a separate farm/field/season knowledge design after Phase 1, or expand this specification before implementation?

## Out of scope for Phase 1

- Building the farm/field/season knowledge base or cross-conversation document retrieval.
- Changing expert roster, deliverables, conversation history limits, weather provider, or agricultural recommendation policies.
- Applying database migrations or pushing schema changes to any configured database without separate review of the target.
