import type { AgentId, AgentProfile } from "./agentTypes.ts";
import type { WorkflowPhase } from "../tasks/taskTypes.ts";
import type { LocationId } from "../simulation/worldLayout.ts";

export const AGENTS: AgentProfile[] = [
  { id: "orion", name: "Orion", role: "orchestrator", roleLabel: "Orchestrator", tagline: "Coordinates work and delegates tasks", color: "#E8B04A", home: "hub", seat: 0 },
  { id: "iris", name: "Iris", role: "researcher", roleLabel: "Researcher", tagline: "Researches technical topics and gathers information", color: "#5CC8D7", home: "research", seat: 1 },
  { id: "piper", name: "Piper", role: "product_manager", roleLabel: "Product Manager", tagline: "Converts requirements into actionable tasks", color: "#A78BFA", home: "product", seat: 2 },
  { id: "kai", name: "Kai", role: "engineer", roleLabel: "Software Engineer", tagline: "Implements software features", color: "#6C9EFF", home: "dev", seat: 3 },
  { id: "quinn", name: "Quinn", role: "qa", roleLabel: "QA Engineer", tagline: "Tests completed work", color: "#5FD39A", home: "testing", seat: 4 },
  { id: "rex", name: "Rex", role: "reviewer", roleLabel: "Code Reviewer", tagline: "Reviews implementation quality", color: "#F08A7E", home: "review", seat: 5 },
];

export const AGENT_IDS: AgentId[] = AGENTS.map((a) => a.id);

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

export function getAgent(id: AgentId): AgentProfile {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`Unknown agent ${id}`);
  return a;
}

/** Who owns each phase, and where they stand to do it. `done` is Orion's finalize step. */
export const PHASE_OWNER: Partial<Record<WorkflowPhase, { agent: AgentId; location: LocationId }>> = {
  intake: { agent: "orion", location: "hub" },
  planning: { agent: "piper", location: "planning" },
  research: { agent: "iris", location: "research" },
  implementation: { agent: "kai", location: "dev" },
  testing: { agent: "quinn", location: "testing" },
  review: { agent: "rex", location: "review" },
  done: { agent: "orion", location: "hub" },
};

export const STATION_OWNERS: Partial<Record<LocationId, AgentId>> = {
  ops: "orion",
  research: "iris",
  product: "piper",
  dev: "kai",
  testing: "quinn",
  review: "rex",
};
