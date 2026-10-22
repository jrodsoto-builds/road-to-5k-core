/** OpenAI function-calling definitions and local mock handlers for the run coach. */

export interface CoachToolCall {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, never>;
      required: string[];
      additionalProperties: false;
    };
  };
}

// MOCK — vision replaces these sample readings later.
const distanceSamples: Array<{
  distanceMeters: number | null;
  trend: 'closing' | 'holding' | 'pulling-away' | 'none';
}> = [
  {distanceMeters: 14, trend: 'closing'},
  {distanceMeters: 16, trend: 'holding'},
  {distanceMeters: 13, trend: 'pulling-away'},
  {distanceMeters: 18, trend: 'closing'},
  {distanceMeters: 15, trend: 'holding'},
  {distanceMeters: null, trend: 'none'},
];
let distanceSampleIndex = 0;

export function getRunnerDistance(): (typeof distanceSamples)[number] {
  const sample = distanceSamples[distanceSampleIndex % distanceSamples.length];
  distanceSampleIndex += 1;
  return {...sample};
}

// MOCK — vision replaces these sample counts later.
const passerSamples: Array<{
  passedYou: number;
  youPassed: number;
  inYourAgeGroup: number;
}> = [
  {passedYou: 3, youPassed: 5, inYourAgeGroup: 2},
  {passedYou: 4, youPassed: 6, inYourAgeGroup: 3},
  {passedYou: 2, youPassed: 4, inYourAgeGroup: 1},
  {passedYou: 3, youPassed: 7, inYourAgeGroup: 2},
  {passedYou: 0, youPassed: 0, inYourAgeGroup: 0},
];
let passerSampleIndex = 0;

export function countPassersby(): (typeof passerSamples)[number] {
  const sample = passerSamples[passerSampleIndex % passerSamples.length];
  passerSampleIndex += 1;
  return {...sample};
}

export const coachTools: CoachToolCall[] = [
  {
    type: 'function',
    function: {
      name: 'getRunnerDistance',
      description:
        'Get the distance in meters to the runner directly ahead and whether the gap is closing, holding, or pulling away. Always return distanceMeters (number or null) and trend (closing, holding, pulling-away, or none); use null and none when no runner is ahead.',
      parameters: {type: 'object', properties: {}, required: [], additionalProperties: false},
    },
  },
  {
    type: 'function',
    function: {
      name: 'countPassersby',
      description:
        'Count runners who passed the wearer, runners the wearer passed, and runners in the wearer’s age group. Always return passedYou, youPassed, and inYourAgeGroup as numbers, using zero when there are none.',
      parameters: {type: 'object', properties: {}, required: [], additionalProperties: false},
    },
  },
];

type CoachToolHandler = () => unknown;
type ModelContext = {
  registerTool?: (tool: {name: string; description: string; parameters: CoachToolCall['function']['parameters']; execute: CoachToolHandler}) => void;
};

/** Register coach tools with the browser model context when it is available. */
export function registerCoachTools(): void {
  const modelContext = (document as Document & {modelContext?: ModelContext}).modelContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') return;

  modelContext.registerTool({...coachTools[0].function, execute: getRunnerDistance});
  modelContext.registerTool({...coachTools[1].function, execute: countPassersby});
}
