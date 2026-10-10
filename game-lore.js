// Story text for a mission. Two engines share one shape ({ title, briefing[], chatter[], win, lose }):
//   - templates (here): always available, seeded, built from the mission's real facts;
//   - WebLLM (later, opt-in): writes the same shape from the same facts plus the player's lore bible.
// Text never changes a mission's numbers; the Director owns those.

import { rng } from "./game-rng.js";

const CALL = ["Kestrel", "Halcyon", "Vesper", "Corvid", "Lumen", "Tamsin", "Ardent", "Solace"];
const OPEN = ["Pilot, listen up.", "Wake up, flyer.", "Command to all wings.", "Sorry to pull you off patrol.", "We have a live one."];
const TITLE = {
  "storm-run": ["Radiant Front", "Between the Fronts", "Under the Flare"], "aurora-raid": ["Aurora Raiders", "Storm Riders", "Ion Tide"],
  intercept: ["Rock and a Hard Place", "Breaking Point", "Close Approach"], escort: ["Clear Skies", "Ascent Guard", "Max Q"],
  salvage: ["Picking the Bones", "After the Burn", "Scrap Lane"], rendezvous: ["Station Keeping", "Overhead", "Docking Run"],
  rescue: ["Pods in the Dark", "Drift Recovery", "Coming Home"], recon: ["Quiet Eyes", "Long Exposure", "Farside"],
  skirmish: ["First Contact", "Hold the Lane", "Shots Fired"], expedition: ["Far Waypoints", "Beyond the Reach", "Survey Line"],
  relay: ["Hold the Array", "Signal Fire", "Keep Talking"], patrol: ["Night Patrol", "Lane Sweep", "Quiet Watch"],
};
const WHY = {
  "storm-run": "The front scrambles everything it touches; the buoys are the only clean record of it.",
  "aurora-raid": "Raiders hide in the storm's noise and hit anything that blinks.",
  intercept: "Mining crews say the rock carries more than ice. So do the people already chasing it.",
  escort: "Someone wants that payload to never reach orbit.",
  salvage: "Spent hardware is worth a fortune to whoever reaches it first.",
  rendezvous: "The station is running short and only one gate sequence lines up today.",
  rescue: "The pods won't last long out there, and they aren't alone.",
  recon: "Get close, get the scans, get out. Don't start a fight you don't need.",
  skirmish: "They crossed the line. Show them where it was.",
  expedition: "Nobody has charted that far out since the news broke.",
  relay: "Lose the relay and the whole sector goes dark.",
  patrol: "Something is moving in the lanes. Find it.",
};

export function templateLore(mission, board) {
  const r = rng(`lore:${mission.id}`);
  const f = board.factions.find((x) => x.id === mission.faction) ?? board.factions[0];
  const call = r.pick(CALL), enemies = mission.waves.flatMap((w) => w.enemies).reduce((n, e) => n + e.count, 0);
  const title = r.pick(TITLE[mission.archetype] ?? TITLE.patrol);
  const fact = mission.hook.fact.charAt(0).toUpperCase() + mission.hook.fact.slice(1);
  const briefing = [
    `${r.pick(OPEN)} ${fact}.`,
    `${WHY[mission.archetype] ?? WHY.patrol} The ${f.name} ${r.pick(["got there first", "is already moving", "wants it too", "has been waiting for this"])}.`,
    `${mission.objective.text}${mission.objective.count ? ` (${mission.objective.count})` : ""}. You have ${Math.round(mission.timeLimitSec / 60 * 10) / 10} minutes.`,
    ...mission.bonuses.map((b) => `Bonus ×${b.mult}: ${b.reason}.`),
  ];
  const chatter = [
    `${call} here, I've got your six.`,
    `${enemies} contacts, ${f.name} markings.`,
    mission.hazards[0] ? `Watch the ${mission.hazards[0].type.replace("-", " ")}.` : `Sky's clear apart from them.`,
    r.pick(["Nice shooting.", "That's how it's done.", "Keep it tight.", "Don't get greedy."]),
  ];
  return { engine: "template", title, briefing, chatter,
    win: `${title}: done. ${r.pick(["The sector breathes again.", "Command owes you one.", "That'll make the news too."])}`,
    lose: `${title}: we lost it. ${r.pick(["The sky doesn't wait.", "There'll be another signal.", "Regroup and go again."])}` };
}
