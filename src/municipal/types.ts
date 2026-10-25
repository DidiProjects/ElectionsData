export interface Municipality {
  state: string;
  code: string;
  ibgeCode: string;
  name: string;
}

export interface PollTarget {
  municipality: Municipality;
  officeCode: number;
}

export type TotalizationStatus = 'not_started' | 'in_progress' | 'finished';

export interface SectionProgress {
  total: number;
  counted: number;
  countedPct: number;
}

export interface VoteSummary {
  electorate: number;
  turnout: number;
  abstention: number;
  valid: number;
  blank: number;
  null: number;
}

export interface CandidateResult {
  number: string;
  name: string;
  ballotName: string;
  party: string;
  coalition: string;
  votes: number;
  votesPct: number;
  status: string;
  elected: boolean;
}

export interface MunicipalityResult {
  electionCode: number;
  round: number;
  officeCode: number;
  officeName: string;
  municipality: Municipality;
  /** TSE generation id; monotonically increasing across publications of the same file. */
  generationId: number;
  generatedAt: string;
  totalizationStatus: TotalizationStatus;
  totalizationDate: string;
  totalizationTime: string;
  sections: SectionProgress;
  votes: VoteSummary;
  candidates: CandidateResult[];
}
