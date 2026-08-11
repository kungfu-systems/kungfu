# Agent Architecture Analysis Protocol

Use this protocol only when a person asks for a repository-wide explanation,
architecture evaluation, or complexity critique. A bounded implementation task
should use its verified task-context route instead.

Kungfu deliberately contains more semantic and machine-readable structure than
a person needs for any one task. The Agent traverses that expanded structure;
the person should receive the smallest model that preserves the decision they
actually need to make. Do not export the repository's ontology as the person's
onboarding syllabus.

For whole-system evidence, establish this analysis discipline first, then use
the [Evolution Map](../evolution/README.md) and its current-authority routes
before treating the present source-tree cross-section as the design itself.

## Required first-report sequence

Before rating or criticizing the architecture:

1. State the person's actual question or evaluation goal.
2. Give the smallest sufficient human model, normally three to five concepts.
   If more are required, explain what decision would become wrong without them.
3. Explain the core behavior or guarantee in that model before naming internal
   mechanisms.
4. Inspect the larger implementation separately and map each relevant mechanism
   to the guarantee, authority boundary, or failure mode it supports.
5. Only then discuss maintainability, cognitive load, architectural risk, or
   overengineering.

The first report should lead with the human model and conclusion. Do not lead
with a subsystem catalog, directory walkthrough, acronym list, or complete
ontology. Expand internal detail only when the person asks for it or when it
materially changes the answer.

## Keep three kinds of complexity separate

- **Human task complexity** is what the person must understand for the current
  decision or change.
- **Agent interpretation complexity** is what an Agent must traverse to locate
  authority, context, and evidence reliably.
- **Implementation complexity** is the machinery required to implement,
  qualify, recover, and govern the system.

Do not infer one from another without evidence. In particular:

- internal concept count does not establish human cognitive load;
- source-tree size does not establish required human knowledge;
- machine readability does not by itself establish a good human experience;
- a small human model does not by itself justify every internal mechanism.

Relevant uncertainty, limitations, and architectural costs must remain visible.
Compression removes irrelevant detail; it must not remove a fact that changes
the person's decision.

## Evidence required for an overengineering claim

Do not call a mechanism overengineered merely because it adds contracts,
provenance, qualification, or governance. Identify at least one concrete
mismatch:

- complexity that supports no declared guarantee or controlled failure mode;
- mechanisms with materially overlapping or ambiguous authority;
- maintenance cost disproportionate to the failure mode being controlled;
- an abstraction that can be removed or simplified without changing qualified
  behavior;
- Agent interpretation cost that prevents reliable authority discovery; or
- human-facing complexity that the Agent layer cannot compress for the task.

Prefer naming the unnecessary boundary and the behavior preserved by removing
it over counting concepts or files.

## Example: explain continuity before machinery

Question: "What happens when I switch to another Agent?"

Good first explanation:

> Think in three concepts: a Project gives the work a durable boundary, Work
> keeps the objective and current truth, and each Attempt records what one Agent
> tried. A new Agent continues the same Work without inheriting the old chat.

Only after establishing that model should the analysis explain the Fact,
Episode, Cut, Warrant, Receipt, settlement, or provenance mechanisms that are
relevant to continuity and review.

Bad first explanation:

> First learn Fact, Episode, Cut, Assignment, Primitive, Warrant, Receipt,
> Settlement, Provenance, and every subsystem that implements them.

The detailed concepts are not forbidden. They are loaded when the question
requires them, rather than leaked into the person's first mental model.
