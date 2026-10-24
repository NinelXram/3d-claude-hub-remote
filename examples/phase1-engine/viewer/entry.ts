// Browser bundle for the viewer: exposes the engine as the global `AAW`. Built by scripts/build-viewer.mjs.
export { MockAgentBackend } from "../src/integrations/MockAgentBackend.ts";
export { AGENTS, getAgent, STATION_OWNERS } from "../src/agents/AgentRegistry.ts";
export { LOCATIONS, HUB_CENTER, MISSION_CONTROL, CORRIDOR_Z, FLOOR } from "../src/simulation/worldLayout.ts";
export { SIM_CONFIG } from "../src/simulation/simulationConfig.ts";
export { isCommunication } from "../src/events/eventTypes.ts";
export { isTerminal } from "../src/simulation/WorkflowStateMachine.ts";
export { shortTitle } from "../src/simulation/workContent.ts";
export { DEMO_TASK } from "../src/tasks/taskActions.ts";
export { SPRINT_TASKS, pickRandomTask } from "../src/tasks/taskBacklog.ts";
export { WebSocketAgentBackend } from "../src/integrations/WebSocketAgentBackend.ts";
export { SoundEngine } from "./soundEngine.ts";
