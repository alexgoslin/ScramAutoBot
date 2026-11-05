// Control-flow errors for Autopilot: pause for the human, or stop on request.
// options: choices the site shows instead of a bare Resume ([{id,label,recommended?}]).
export class PauseError extends Error {
  constructor(message, { options = null } = {}) {
    super(message);
    this.options = options;
  }
}
// The choices offered when a step is stuck or the supervisor can't answer (autopilotPauseChoice).
export const PAUSE_CHOICES = ["fresh_chat", "redo_step", "skip_step", "resume"];
export function pauseOptions(recommend = "fresh_chat") {
  const labels = { fresh_chat: "Start a fresh Scram chat for this step", redo_step: "Redo this step from scratch", skip_step: "Skip this step and continue", resume: "Just resume" };
  return PAUSE_CHOICES.map((id) => ({ id, label: labels[id], ...(id === recommend ? { recommended: true } : {}) }));
}
export class StopError extends Error {}
