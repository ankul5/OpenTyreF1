import axios from 'axios';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

const API_PORT = 8000;
const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

/** True for a host that only means anything on the current Wi-Fi network. */
const isLanHost = (url: string) => {
  const host = url.replace(/^https?:\/\//, '').split(':')[0];
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '10.0.2.2' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
};

/**
 * The LAN IP Metro is being served from, e.g. "10.137.147.17:8081" -> the phone
 * reached us on that address, so the backend is reachable there too.
 */
const metroHost = () => {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  const host = hostUri?.split(':')[0];
  return host && host !== 'localhost' && host !== '127.0.0.1' ? host : null;
};

/**
 * Resolution order, and why:
 *
 * A hardcoded LAN IP in .env goes stale every time the router hands out a new
 * lease, which shows up as a permanent "Backend offline" even though the server
 * is running fine. So in development the Metro host wins over a LAN-shaped
 * EXPO_PUBLIC_API_URL — it is by definition an address this device just reached.
 *
 * A non-LAN EXPO_PUBLIC_API_URL (a deployed https:// backend) always wins: it is
 * a deliberate choice, and it is what release builds are given.
 */
const getBaseUrl = () => {
  if (configuredUrl && !isLanHost(configuredUrl)) {
    return configuredUrl;
  }

  if (__DEV__) {
    const host = metroHost();
    if (host) {
      return `http://${host}:${API_PORT}`;
    }
  }

  if (configuredUrl) {
    return configuredUrl;
  }

  // Android emulator maps the host machine's loopback to 10.0.2.2.
  return Platform.OS === 'android'
    ? `http://10.0.2.2:${API_PORT}`
    : `http://localhost:${API_PORT}`;
};

export const API_BASE_URL = getBaseUrl();

if (__DEV__) {
  console.log(`[api] base URL: ${API_BASE_URL}`);
}

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 8000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface HealthResponse {
  status: string;
  database: string;
}

export const fetchHealthStatus = async (): Promise<HealthResponse> => {
  const response = await apiClient.get<HealthResponse>('/api/health');
  return response.data;
};

export interface DriverListItem {
  driverId: string;
  givenName: string;
  familyName: string;
  code: string | null;
  permanentNumber: string | null;
  nationality: string | null;
  team: string | null;
  lastSeason: number | null;
  wins: number;
  headshotUrl: string | null;
}

export interface DriverListResponse {
  items: DriverListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export const fetchDrivers = async (search?: string): Promise<DriverListResponse> => {
  const response = await apiClient.get<DriverListResponse>('/api/drivers', {
    params: search ? { search } : undefined,
  });
  return response.data;
};

export interface DriverCareer {
  starts: number;
  wins: number;
  podiums: number;
  poles: number;
  points: number;
  championships: number;
}

export interface TeamHistoryEntry {
  constructorId: string;
  name: string;
  fromYear: number;
  toYear: number;
  races: number;
}

export interface DriverDetail {
  driverId: string;
  givenName: string;
  familyName: string;
  code: string | null;
  permanentNumber: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  headshotUrl: string | null;
  career: DriverCareer;
  teamHistory: TeamHistoryEntry[];
  seasons: number[];
}

export const fetchDriverDetail = async (driverId: string): Promise<DriverDetail> => {
  const response = await apiClient.get<DriverDetail>(`/api/drivers/${driverId}`);
  return response.data;
};

export interface SeasonRace {
  round: number;
  raceName: string;
  circuitName: string | null;
  date: string | null;
  team: string;
  grid: number | null;
  position: number | null;
  points: number | null;
  status: string | null;
}

export interface DriverSeason {
  driverId: string;
  season: number;
  standing: { position: number | null; points: number | null; wins: number | null } | null;
  races: SeasonRace[];
}

export const fetchDriverSeason = async (driverId: string, year: number): Promise<DriverSeason> => {
  const response = await apiClient.get<DriverSeason>(`/api/drivers/${driverId}/seasons/${year}`);
  return response.data;
};

// ---------------------------------------------------------------------------
// Sessions (Live screen)
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  position: number | null;
  driverId: string | null;
  driverNumber: number | null;
  name: string | null;
  code: string | null;
  team: string | null;
  teamColour: string;
  headshotUrl: string | null;
  /** Only present on RaceRecap.classification, not the live/latest leaderboard. */
  grid?: number | null;
  gap: string | null;
  laps: number | null;
  points: number | null;
  tyreCompound: string | null;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
}

export interface SessionWeather {
  airTemperature: number | null;
  trackTemperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  rainfall: number | null;
}

export interface SessionLive {
  sessionKey: number;
  raceId: string | null;
  sessionName: string | null;
  circuit: string | null;
  location: string | null;
  country: string | null;
  year: number;
  dateStart: string | null;
  mode: 'live' | 'latest_completed';
  liveAvailable: boolean;
  totalLaps: number;
  leaderboard: LeaderboardEntry[];
  weather: SessionWeather | null;
}

export const fetchLatestSession = async (): Promise<SessionLive> => {
  const { data } = await apiClient.get<SessionLive>('/api/sessions/latest');
  return data;
};

export const fetchSessionLive = async (sessionKey: number): Promise<SessionLive> => {
  const { data } = await apiClient.get<SessionLive>(`/api/sessions/${sessionKey}/live`);
  return data;
};

export interface TrackPastWinner {
  year: number;
  raceName: string;
  driverId: string;
  driverName: string;
  code: string | null;
  team: string | null;
  grid: number | null;
}

export interface TrackLapRecord {
  seconds: number;
  time: string;
  driverId: string;
  driverName: string | null;
  code: string | null;
  year: number;
  note: string;
}

export interface SessionTrack {
  sessionKey: number;
  raceId: string | null;
  circuit: string | null;
  circuitName: string | null;
  raceName: string | null;
  location: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  date: string | null;
  year: number;
  totalLaps: number;
  weather: SessionWeather | null;
  history: {
    timesHeld: number;
    firstGrandPrix: number | null;
    lastGrandPrix: number | null;
  };
  lapRecord: TrackLapRecord | null;
  pastWinners: TrackPastWinner[];
}

export const fetchSessionTrack = async (sessionKey: number): Promise<SessionTrack> => {
  const { data } = await apiClient.get<SessionTrack>(`/api/sessions/${sessionKey}/track`);
  return data;
};

// ---------------------------------------------------------------------------
// Races (list / replay / recap)
// ---------------------------------------------------------------------------

export interface RaceListItem {
  raceId: string;
  season: number;
  round: number;
  raceName: string;
  circuitName: string | null;
  date: string | null;
  sessionKey: number;
}

export const fetchRaces = async (params?: { season?: number; search?: string }) => {
  const { data } = await apiClient.get<{ items: RaceListItem[] }>('/api/races', { params });
  return data;
};

export interface ReplayEntryDTO {
  position: number;
  driverId: string;
  code: string | null;
  name: string | null;
  team: string | null;
  teamColour: string;
  gap: number | null;
  tyreCompound: string | null;
  tyreLife: number | null;
  lapTime: number | null;
  isPitOutLap: boolean | null;
}

export interface RaceReplay {
  raceId: string;
  raceName: string | null;
  circuitName: string | null;
  season: number | null;
  sessionKey: number;
  totalLaps: number;
  frames: { lap: number; leaderboard: ReplayEntryDTO[] }[];
}

export const fetchRaceReplay = async (raceId: string): Promise<RaceReplay> => {
  const { data } = await apiClient.get<RaceReplay>(`/api/races/${raceId}/replay`);
  return data;
};

export interface RaceRecap {
  raceId: string;
  raceName: string | null;
  circuitName: string | null;
  season: number | null;
  date: string | null;
  sessionKey: number;
  totalLaps: number;
  classification: LeaderboardEntry[];
  tyreStrategy: {
    driverId: string;
    code: string | null;
    name: string | null;
    teamColour: string;
    stints: {
      stint: number | null;
      compound: string | null;
      lapStart: number;
      lapEnd: number;
      laps: number;
      tyreAgeAtStart: number | null;
    }[];
  }[];
  positionChart: {
    driverId: string;
    code: string | null;
    teamColour: string;
    points: { lap: number; position: number }[];
  }[];
  pitStops: {
    driverId: string | null;
    code: string | null;
    team: string | null;
    teamColour: string;
    lap: number | null;
    duration: number;
  }[];
  pace: {
    driverId: string;
    code: string | null;
    teamColour: string;
    medianLap: number;
    bestLap: number;
    bestLapNumber: number | null;
    laps: number;
    deltaToBest?: number;
  }[];
  raceControl: {
    lap: number | null;
    category: string | null;
    flag: string | null;
    scope: string | null;
    message: string | null;
    date: string | null;
  }[];
  weather: {
    date: string | null;
    airTemperature: number | null;
    trackTemperature: number | null;
    humidity: number | null;
    windSpeed: number | null;
    rainfall: number | null;
  }[];
  overtakes: { driverId: string | null; code: string | null; teamColour: string; count: number }[];
  summary: RaceSummary;
}

export interface RaceSummary {
  podium: LeaderboardEntry[];
  fastestLap: {
    driverId: string;
    code: string | null;
    teamColour: string;
    medianLap: number;
    bestLap: number;
    bestLapNumber: number | null;
    laps: number;
    deltaToBest?: number;
  } | null;
  biggestGainer: {
    driverId: string;
    code: string | null;
    name: string | null;
    teamColour: string;
    grid: number;
    finish: number;
    positionsGained: number;
  } | null;
  winningStrategy: {
    driverId: string;
    code: string | null;
    sequence: string[];
    stops: number;
  } | null;
  conditions: {
    airTemperature: number | null;
    trackTemperature: number | null;
    wet: boolean;
  } | null;
}

export const fetchRaceRecap = async (raceId: string): Promise<RaceRecap> => {
  const { data } = await apiClient.get<RaceRecap>(`/api/races/${raceId}/recap`);
  return data;
};

// ---------------------------------------------------------------------------
// Upcoming races (5b)
// ---------------------------------------------------------------------------

export interface UpcomingRace {
  raceId: string;
  season: number;
  round: number;
  raceName: string;
  circuitName: string | null;
  country: string | null;
  locality: string | null;
  date: string;
  time: string | null;
  lat: number | null;
  lng: number | null;
  daysUntil: number;
  isThisWeekend: boolean;
}

export const fetchUpcomingRaces = async (limit = 5): Promise<{ items: UpcomingRace[] }> => {
  const { data } = await apiClient.get<{ items: UpcomingRace[] }>('/api/races/upcoming', {
    params: { limit },
  });
  return data;
};

// ---------------------------------------------------------------------------
// Deeper analysis metrics (5e)
// ---------------------------------------------------------------------------

export interface RaceAnalysis {
  degradation: {
    driverId: string;
    code: string | null;
    teamColour: string;
    stint: number;
    compound: string | null;
    degradationPerLap: number;
    laps: number;
  }[];
  teammateGaps: {
    team: string;
    fasterDriverId: string;
    fasterCode: string | null;
    slowerDriverId: string;
    slowerCode: string | null;
    gapSeconds: number;
    teamColour: string;
  }[];
  biggestGainers: {
    driverId: string;
    code: string | null;
    teamColour: string;
    grid: number;
    finish: number;
    positionsGained: number;
  }[];
  consistency: {
    driverId: string;
    code: string | null;
    teamColour: string;
    stdDevSeconds: number;
    laps: number;
  }[];
  sectorDeltas: {
    driverId: string;
    code: string | null;
    teamColour: string;
    sector1: number | null;
    sector2: number | null;
    sector3: number | null;
    sector1Delta: number | null;
    sector2Delta: number | null;
    sector3Delta: number | null;
  }[];
  dirtyAirLoss: {
    followingMedian: number | null;
    clearAirMedian: number | null;
    lossSeconds: number | null;
    followingSampleSize: number;
    clearAirSampleSize: number;
  };
}

export const fetchRaceAnalysis = async (raceId: string): Promise<RaceAnalysis> => {
  const { data } = await apiClient.get<RaceAnalysis>(`/api/races/${raceId}/analysis`);
  return data;
};

// ---------------------------------------------------------------------------
// Telemetry (on-demand; heavier, so callers should enable these lazily)
// ---------------------------------------------------------------------------

export interface TelemetrySampleDTO {
  date: string | null;
  speed: number | null;
  throttle: number | null;
  brake: number | null;
  gear: number | null;
  drs: number | null;
  rpm: number | null;
  progress?: number;
}

export interface LapTelemetry {
  sessionKey: number;
  driverId: string;
  driverNumber: number;
  lap: number;
  lapTime: number | null;
  samples: TelemetrySampleDTO[];
}

export const fetchTelemetryCompare = async (params: {
  sessionKey: number;
  driverA: string;
  driverB: string;
  lapA: number;
  lapB?: number;
}) => {
  const { data } = await apiClient.get<{ sessionKey: number; drivers: LapTelemetry[] }>(
    '/api/telemetry/compare',
    {
      params: {
        session_key: params.sessionKey,
        driver_a: params.driverA,
        driver_b: params.driverB,
        lap_a: params.lapA,
        lap_b: params.lapB,
      },
      timeout: 30000,
    },
  );
  return data;
};

export interface TrackMapData {
  sessionKey: number;
  driverId: string;
  lap: number;
  points: { x: number; y: number; date: string | null }[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

export const fetchTrackMap = async (sessionKey: number, driverId?: string) => {
  const { data } = await apiClient.get<TrackMapData>('/api/telemetry/track-map', {
    params: { session_key: sessionKey, driver_id: driverId },
    timeout: 30000,
  });
  return data;
};

// ---------------------------------------------------------------------------
// Strategy simulation (Phase 3)
// ---------------------------------------------------------------------------

export type Compound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET';

export interface StintPlan {
  compound: Compound;
  laps: number;
  tyreAgeAtStart?: number;
}

export interface ModelStatus {
  available: boolean;
  error?: string | null;
  trainedAt?: string;
  trainingRows?: number;
  trainingRaces?: number;
  holdoutRaces?: number;
  years?: [number, number];
  metrics?: {
    model: { mae: number; rmse: number; r2: number };
    baseline_driver_circuit_median: { mae: number; rmse: number; r2: number };
    baseline_driver_circuit_season_median: { mae: number; rmse: number; r2: number };
    mae_improvement_seconds: number;
  };
  featureImportance?: Record<string, number>;
  circuitsCovered?: number;
}

export interface StrategyDriverOption {
  driverId: string;
  code: string | null;
  name: string | null;
  team: string | null;
  teamColour: string;
  headshotUrl: string | null;
  finishPosition: number | null;
  dnf: boolean;
  actualStints: { compound: string | null; laps: number }[];
}

export interface StrategyOptions {
  raceId: string;
  raceName: string | null;
  circuitName: string | null;
  season: number | null;
  date: string | null;
  sessionKey: number;
  raceLaps: number;
  compounds: Compound[];
  pitLossSeconds: number;
  pitLossSource: string;
  drivers: StrategyDriverOption[];
  defaultDriverId: string | null;
  model: ModelStatus;
}

export const fetchStrategyOptions = async (raceId: string): Promise<StrategyOptions> => {
  const { data } = await apiClient.get<StrategyOptions>(`/api/strategy/options/${raceId}`);
  return data;
};

export const fetchModelStatus = async (): Promise<ModelStatus> => {
  const { data } = await apiClient.get<ModelStatus>('/api/strategy/model');
  return data;
};

export interface StintBreakdown {
  stint: number;
  compound: string;
  laps: number;
  lapStart: number;
  lapEnd: number;
  /** Laps in this stint run behind a safety car or red flag in the real race. */
  neutralisedLaps: number;
  averageLap: number;
  openingLap: number;
  closingLap: number;
  degradationPerLap: number;
}

export interface DegradationPoint {
  lap: number;
  stint: number;
  compound: string;
  tyreLife: number;
  predictedTime: number;
  cumulativeTime: number;
  pitStop: boolean;
  /** Held at the field's actual pace because strategy could not change it. */
  neutralised: boolean;
}

export interface SimulationResult {
  raceId: string;
  raceName: string | null;
  circuitName: string | null;
  season: number | null;
  sessionKey: number;
  driver: {
    driverId: string;
    code: string | null;
    name: string | null;
    team: string | null;
    teamColour: string;
    headshotUrl: string | null;
  };
  raceLaps: number;
  plannedLaps: number;
  comparedOverLaps: number;
  totalTime: number;
  pitStops: number;
  pitLossSeconds: number;
  pitLossSource: string;
  timeLostInPits: number;
  /** Laps the real race ran under a safety car or red flag. */
  neutralisedLaps: number;
  /** The field's median clean lap, the pace everything else is measured from. */
  referencePace: number | null;
  projectedFinishDelta: number | null;
  projectedPosition: number | null;
  actual: {
    position: number | null;
    dnf: boolean;
    /** Reconstructed by summing laps, so it exists at any lap number. */
    totalTime: number | null;
    /** OpenF1's classified race time. Should agree with totalTime. */
    officialTime: number | null;
    lapsCompleted: number | null;
    stints: { compound: string | null; laps: number }[];
    stops: number;
  };
  stintBreakdown: StintBreakdown[];
  degradationCurve: DegradationPoint[];
  /** Same shape as RaceReplay.frames, so <RaceReplayPlayer> renders both. */
  frames: { lap: number; leaderboard: (ReplayEntryDTO & { simulated: boolean })[] }[];
  uncertainty: {
    perLapMaeSeconds: number | null;
    totalTimeMarginSeconds: number | null;
    notes: string[];
  };
  warnings: string[];
  modelSource: 'trained' | 'empirical';
  modelDetail: string;
  circuitInTraining: boolean;
  driverInTraining: boolean;
  /** Correction applied against this driver's own clean laps in this race. */
  driverCalibrationSeconds: number | null;
}

export const runSimulation = async (body: {
  raceId: string;
  driverId: string;
  stints: StintPlan[];
  pitLossSeconds?: number;
}): Promise<SimulationResult> => {
  const { data } = await apiClient.post<SimulationResult>('/api/strategy/simulate', body, {
    timeout: 30000,
  });
  return data;
};

// ---------------------------------------------------------------------------
// Pitwall decision modules
//
// Every module below answers the same question in a different way — "at this
// lap of this real race, what was the right call, and what actually
// happened?" — and every response shares one envelope shape
// (`PitwallResponse`), so <RecommendationCard> never has to special-case a
// module. `sampleSize` and `source` are never omitted: a 13-race red-flag
// sample should look like 13, not a bar chart that quietly assumes a
// thousand.
// ---------------------------------------------------------------------------

export interface PitwallFact {
  label: string;
  value: string;
}

export interface PitwallResponse {
  verdict: string;
  confidence: number;
  expectedGain: number | null;
  reasoning: string[];
  facts: PitwallFact[];
  sampleSize: number;
  source: 'measured' | 'derived' | 'modelled';
  actual: Record<string, unknown>;
}

export interface OutcomeResponse extends PitwallResponse {
  histogram: { position: number; probability: number }[];
  raceLaps: number;
  lap: number;
  maxPosition: number;
}

export interface PitwallEvent {
  type: 'SC' | 'VSC' | 'YELLOW' | 'DOUBLE_YELLOW' | 'RED' | 'OTHER' | 'UNKNOWN';
  category: 'neutralisation' | 'flag';
  deployedLap: number;
  clearedLap: number | null;
  laps: number[] | null;
  scope?: string | null;
}

export interface PitwallDriverState {
  driverId: string;
  code: string | null;
  name: string | null;
  team: string | null;
  teamColour: string;
  position: number | null;
  compound: string | null;
  tyreLife: number | null;
  stint: number | null;
  pitStops: number;
  gapAhead: number | null;
  gapBehind: number | null;
  asOfLap: number;
}

export interface RaceState {
  raceId: string;
  raceName: string | null;
  sessionKey: number;
  raceLaps: number;
  lap: number;
  drivers: PitwallDriverState[];
  events: PitwallEvent[];
  weather: { trackTemp: number | null; airTemp: number | null; isWet: boolean | null };
}

export const fetchRaceState = async (raceId: string, lap?: number): Promise<RaceState> => {
  const { data } = await apiClient.get<RaceState>(`/api/strategy/state/${raceId}`, {
    params: lap != null ? { lap } : undefined,
  });
  return data;
};

type PitwallModule = 'safety-car' | 'flags' | 'weather' | 'overtake' | 'defence';

const fetchPitwall = async (
  module: PitwallModule,
  raceId: string,
  driverId: string,
  lap: number,
): Promise<PitwallResponse> => {
  const { data } = await apiClient.get<PitwallResponse>(`/api/strategy/${module}/${raceId}`, {
    params: { driver_id: driverId, lap },
  });
  return data;
};

export const fetchSafetyCarCall = (raceId: string, driverId: string, lap: number) =>
  fetchPitwall('safety-car', raceId, driverId, lap);

export const fetchFlagsCall = (raceId: string, driverId: string, lap: number) =>
  fetchPitwall('flags', raceId, driverId, lap);

export const fetchWeatherCall = (raceId: string, driverId: string, lap: number) =>
  fetchPitwall('weather', raceId, driverId, lap);

export const fetchOvertakeCall = (raceId: string, driverId: string, lap: number) =>
  fetchPitwall('overtake', raceId, driverId, lap);

export const fetchDefenceCall = (raceId: string, driverId: string, lap: number) =>
  fetchPitwall('defence', raceId, driverId, lap);

export const fetchOutcomeCall = async (raceId: string, driverId: string, lap: number): Promise<OutcomeResponse> => {
  const { data } = await apiClient.get<OutcomeResponse>(`/api/strategy/outcome/${raceId}`, {
    params: { driver_id: driverId, lap },
    timeout: 30000,
  });
  return data;
};

export const fetchRiskCall = async (raceId: string, driverId: string, lap: number): Promise<PitwallResponse> => {
  const { data } = await apiClient.get<PitwallResponse>(`/api/strategy/risk/${raceId}`, {
    params: { driver_id: driverId, lap },
    timeout: 30000,
  });
  return data;
};

// ---------------------------------------------------------------------------
// Assistant (Phase 4)
// ---------------------------------------------------------------------------

export interface AssistantFact {
  label: string;
  value: string;
  highlight: boolean;
}

export interface AssistantAnswer {
  intent: string;
  answer: string;
  facts: AssistantFact[];
  sources: string[];
  followUps: string[];
  grounded: boolean;
  matchedRaceId?: string | null;
  matchedDrivers?: string[];
}

export interface AssistantContext {
  raceId?: string;
  driverId?: string;
  stints?: StintPlan[];
  pitLossSeconds?: number;
}

export const askAssistant = async (
  question: string,
  context: AssistantContext = {},
): Promise<AssistantAnswer> => {
  const { data } = await apiClient.post<AssistantAnswer>(
    '/api/ai/query',
    { question, context },
    { timeout: 30000 },
  );
  return data;
};

export interface AssistantCapabilities {
  capabilities: string[];
  quickPrompts: { label: string; question: string; needs: 'stints' | 'race' | null }[];
}

export const fetchAssistantCapabilities = async (): Promise<AssistantCapabilities> => {
  const { data } = await apiClient.get<AssistantCapabilities>('/api/ai/capabilities');
  return data;
};
